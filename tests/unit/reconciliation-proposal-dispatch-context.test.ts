/**
 * V5.1 — le contexte canonique jusqu'au fournisseur, et la borne avant lui.
 *
 * Question de preuve :
 *
 * > **Ce que le modèle reçoit réellement est-il le désaccord du run — et le
 * > refus de contexte coûte-t-il vraiment zéro ?**
 *
 * Le fichier voisin éprouve le constructeur isolé. Celui-ci éprouve la
 * **chaîne réelle** : phase A, borne, ledger, adaptateur. Le prompt est capturé
 * à l'endroit exact où il part — l'entrée de l'adaptateur — et non à la sortie
 * du constructeur.
 *
 * Quatre propriétés.
 *
 *  1. **Autonomie.** Le prompt porte les positions ; il ne demande jamais
 *     d'aller lire un fichier ni d'inspecter un répertoire.
 *  2. **Refus PRE-DISPATCH.** Un contexte hors borne est refusé avant le
 *     quota, avant l'`invocation_id`, avant le ledger, avant l'adaptateur.
 *  3. **Audit.** Version, sources lues, taille et condensat sont journalisés ;
 *     le prompt, lui, ne l'est pas.
 *  4. **Session neuve.** `start` est appelé, `resume` jamais.
 *
 * ```text
 * REAL_PROVIDER_CALLS = 0    — l'adaptateur est un double, et il compte
 * ```
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  MAX_PROPOSAL_CONTEXT_UTF8_BYTES,
  PROPOSAL_CONTEXT_VERSION,
} from '../../src/services/reconciliation-proposal-context.ts';
import { requestModelReconciliationProposal } from '../../src/services/reconciliation-proposer.ts';
import { RECONCILIATION_PROPOSAL_OUTPUT_VERSION } from '../../src/services/reconciliation-proposer.ts';
import { runPaths } from '../../src/store/layout.ts';
import type { RunPaths } from '../../src/store/layout.ts';
import { invocationPolicyDocument } from '../../src/core/invocation-policy.ts';
import { isCcrError } from '../../src/core/errors.ts';
import type { AgentAdapter, AgentTurnResult } from '../../src/adapters/agent-adapter.ts';
import type { AgentAdapters, RunServiceDeps } from '../../src/services/run-service.ts';

const RUN_ID = 'CCR-20260821-902';
const CTV = 'ctv_000001';
const E1 = 'ctve_000001';

/** Les deux positions réelles du run `CCR-20260404-001`, en abrégé fidèle. */
const INFRA =
  'Le point décisif est infrastructurel : si le CPU est throttlé hors requête, '
  + 'six boucles de fond sont silencieusement à l’arrêt en production.';
const APPLI =
  'Le défaut le plus important est applicatif, pas infrastructurel : absence de '
  + 'bail et de reprise des jobs restés running.';
const STATEMENT =
  'Les deux experts divergent sur la nature du défaut principal : diagnostic '
  + 'infrastructurel contre diagnostic applicatif.';

interface Harness {
  readonly paths: RunPaths;
  readonly deps: RunServiceDeps;
  prompts(): readonly string[];
  starts(): number;
  resumes(): number;
  dispose(): Promise<void>;
}

/**
 * Run réel sur disque, reproduisant la forme du cas qualifié : une controverse,
 * deux événements ancrés, deux matériaux `RUN_EVENT`, deux adductions `NONE`.
 */
async function harness(options: { authorContent?: string; quota?: number } = {}): Promise<Harness> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccr-v51-ctx-'));
  const runsDir = path.join(dir, 'runs');
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.root, { recursive: true });

  await writeFile(paths.manifest, JSON.stringify({
    schema_version: 2, run_id: RUN_ID, created_at: '2026-08-21T09:00:00.000Z', title: 'contexte',
    workspace: { cwd: runsDir },
    experts: {
      author: { provider: 'claude', session_id: 'S-author' },
      challenger: { provider: 'codex', session_id: 'S-challenger' },
    },
  }), 'utf8');
  await writeFile(paths.state, JSON.stringify({
    schema_version: 3, run_id: RUN_ID, state: 'READY', control: 'AUTOMATION', round: 0,
    active_expert_slot: null, next_step_source_slot: 'author', last_event_id: 'evt_000006',
    updated_at: '2026-08-21T09:00:00.000Z', pending_operation: null,
  }), 'utf8');

  const event = (id: string, slot: string, content: string): string =>
    JSON.stringify({
      event_id: id, run_id: RUN_ID, round: 0, timestamp: '2026-08-21T09:10:00.000Z',
      actor: 'expert', type: 'assistant_response', expert_slot_id: slot,
      session_id: `S-${slot}`, content,
    });

  await writeFile(paths.events, [
    event('evt_000003', 'author', options.authorContent ?? INFRA),
    event('evt_000006', 'challenger', APPLI),
    // Voisin jamais ancré : il ne doit jamais atteindre un fournisseur.
    event('evt_000007', 'author', 'NOTE PRIVÉE — jeton sk-live-XYZ, hors débat'),
  ].join('\n') + '\n', 'utf8');

  await writeFile(paths.controversies, `${JSON.stringify({
    schema_version: 1, entry_id: E1, controversy_id: CTV, kind: 'ASSERTION_RECORDED',
    semantic_origin: { kind: 'HUMAN' }, recorded_by: 'HUMAN',
    recorded_at: '2026-08-21T09:30:00.000Z', round: 0, content: STATEMENT,
    anchors: {
      provenance: [
        { event_id: 'evt_000003', round: 0 },
        { event_id: 'evt_000006', round: 0 },
      ],
    },
  })}\n`, 'utf8');

  const evidence = (value: unknown): string => JSON.stringify(value);
  await writeFile(paths.evidence, [
    evidence({
      schema_version: 1, entry_id: 'mat_000001', kind: 'MATERIAL_RECORDED', recorded_by: 'CCR',
      recorded_at: '2026-08-21T09:40:00.000Z', submitted_by: 'HUMAN', observed_by_ccr: true,
      representation: { form: 'RUN_EVENT', event_id: 'evt_000003' },
      label: 'Réponse de l’auteur — round 0',
    }),
    evidence({
      schema_version: 1, entry_id: 'mat_000002', kind: 'MATERIAL_RECORDED', recorded_by: 'CCR',
      recorded_at: '2026-08-21T09:41:00.000Z', submitted_by: 'HUMAN', observed_by_ccr: true,
      representation: { form: 'RUN_EVENT', event_id: 'evt_000006' },
      label: 'Réponse du challenger — round 0',
    }),
    evidence({
      schema_version: 1, entry_id: 'add_000001', kind: 'ADDUCTION_RECORDED', recorded_by: 'CCR',
      recorded_at: '2026-08-21T09:45:00.000Z', material_id: 'mat_000001',
      target: { kind: 'CONTROVERSY_ENTRY', entry_id: E1 }, orientation: 'NONE',
      semantic_origin: 'HUMAN',
    }),
    evidence({
      schema_version: 1, entry_id: 'add_000002', kind: 'ADDUCTION_RECORDED', recorded_by: 'CCR',
      recorded_at: '2026-08-21T09:46:00.000Z', material_id: 'mat_000002',
      target: { kind: 'CONTROVERSY_ENTRY', entry_id: E1 }, orientation: 'NONE',
      semantic_origin: 'HUMAN',
    }),
  ].join('\n') + '\n', 'utf8');

  if (options.quota !== undefined) {
    await writeFile(paths.invocationPolicy, JSON.stringify(invocationPolicyDocument(options.quota)), 'utf8');
  }

  const prompts: string[] = [];
  let starts = 0;
  let resumes = 0;

  const adapter = (kind: 'claude' | 'codex'): AgentAdapter => ({
    kind,
    async start(prompt: string): Promise<AgentTurnResult> {
      starts += 1;
      prompts.push(prompt);
      const output = JSON.stringify({
        version: RECONCILIATION_PROPOSAL_OUTPUT_VERSION,
        target_controversy_id: CTV,
        proposals: [{ scope: [E1], options: [{ option_id: 'o1', content: 'une option' }] }],
      });
      return {
        agent: kind, sessionId: `ctx-${kind}`, content: output, exitCode: 0,
        startedAt: '2026-08-21T10:00:00.000Z', completedAt: '2026-08-21T10:00:01.000Z',
        stdoutRaw: output, stderrRaw: '',
      };
    },
    resume(): never {
      resumes += 1;
      throw new Error('aucune session native ne doit être reprise');
    },
    openInteractive(): never {
      throw new Error('jamais');
    },
  });

  return {
    paths,
    deps: {
      runsDir,
      now: () => new Date('2026-08-21T12:00:00.000Z'),
      createAdapters: (): AgentAdapters =>
        ({ claude: adapter('claude'), codex: adapter('codex') }) as unknown as AgentAdapters,
    },
    prompts: () => prompts,
    starts: () => starts,
    resumes: () => resumes,
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
}

function propose(h: Harness, slot: 'author' | 'challenger' = 'author'): Promise<unknown> {
  return requestModelReconciliationProposal(h.deps, {
    runId: RUN_ID,
    target_controversy_id: CTV,
    scope_kind: 'WHOLE',
    expert_slot: slot,
  } as Parameters<typeof requestModelReconciliationProposal>[1]);
}

// --------------------------------------------------------------------------
// A. Le prompt réellement envoyé
// --------------------------------------------------------------------------

test('V5.1 — le prompt envoyé porte le désaccord réel et ses deux positions', async () => {
  const h = await harness();
  try {
    await propose(h);
    assert.equal(h.starts(), 1, 'un appel, un prompt capturé');
    const prompt = h.prompts()[0] ?? '';

    // Ce que le modèle n'avait jamais reçu avant cette tranche.
    assert.ok(prompt.includes(STATEMENT), 'l’énoncé de la controverse');
    assert.ok(prompt.includes(INFRA), 'la position de l’auteur');
    assert.ok(prompt.includes(APPLI), 'la position du challenger');
    assert.ok(prompt.includes('evt_000003') && prompt.includes('evt_000006'), 'les événements ancrés');
    assert.ok(prompt.includes('add_000001') && prompt.includes('add_000002'), 'les adductions');
    assert.ok(prompt.includes('mat_000001') && prompt.includes('mat_000002'), 'les matériaux');
    assert.ok(prompt.includes(CTV) && prompt.includes(E1));
  } finally {
    await h.dispose();
  }
});

test('V5.1 — le prompt ne porte rien du run qui ne se rattache pas au périmètre', async () => {
  const h = await harness();
  try {
    await propose(h);
    const prompt = h.prompts()[0] ?? '';
    assert.equal(prompt.includes('evt_000007'), false, 'événement non ancré');
    assert.equal(prompt.includes('sk-live-XYZ'), false, 'aucun secret de fixture ne fuit');
    assert.equal(prompt.includes('NOTE PRIVÉE'), false);
  } finally {
    await h.dispose();
  }
});

test('V5.1 — le prompt est autonome : il n’envoie personne lire un fichier', async () => {
  const h = await harness();
  try {
    await propose(h);
    const prompt = h.prompts()[0] ?? '';
    for (const forbidden of [
      'controversies.jsonl',
      'events.jsonl',
      'evidence.jsonl',
      'workspace',
      'répertoire de travail',
      'va lire',
      'inspecte',
    ]) {
      assert.equal(prompt.includes(forbidden), false, `le prompt ne dit jamais « ${forbidden} »`);
    }
  } finally {
    await h.dispose();
  }
});

test('V5.1 — le prompt distingue les unités soumises du contexte de lecture', async () => {
  const h = await harness();
  try {
    await propose(h);
    const prompt = h.prompts()[0] ?? '';
    assert.ok(prompt.includes('Unités soumises'));
    assert.ok(prompt.includes('ne sont PAS des unités soumises'));
    // Les garde-fous V4 accompagnent les preuves qu'ils encadrent.
    assert.ok(prompt.includes("n'est pas une vérité") || prompt.includes('n’est pas une vérité'));
    assert.ok(prompt.includes('plus grand nombre de matériaux'));
    assert.ok(prompt.includes('orientation est une relation déclarée'));
    assert.ok(prompt.includes('ni rang, ni importance, ni préférence'));
  } finally {
    await h.dispose();
  }
});

test('V5.1 — aucune session native n’est reprise : start oui, resume jamais', async () => {
  const h = await harness();
  try {
    await propose(h);
    assert.equal(h.starts(), 1);
    assert.equal(h.resumes(), 0, 'la continuité cognitive n’est pas requise');
    // Et la session native du run n'est jamais citée dans le prompt.
    assert.equal((h.prompts()[0] ?? '').includes('S-author'), false);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// B. Audit du contexte
// --------------------------------------------------------------------------

async function ledger(h: Harness): Promise<Record<string, unknown>[]> {
  const raw = await readFile(h.paths.invocations, 'utf8');
  return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

test('V5.1 — l’engagement porte version, sources, taille et condensat', async () => {
  const h = await harness();
  try {
    await propose(h);
    const records = await ledger(h);
    assert.equal(records.length, 1);
    const record = records[0] ?? {};

    assert.equal(record['proposal_context_version'], PROPOSAL_CONTEXT_VERSION);
    assert.equal(typeof record['context_utf8_bytes'], 'number');
    assert.match(String(record['context_sha256']), /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(record['context_source_ids'], [
      CTV, E1, 'evt_000003', 'evt_000006', 'add_000001', 'add_000002', 'mat_000001', 'mat_000002',
    ]);

    // La taille auditée est celle du contexte, pas celle du prompt entier.
    const bytes = record['context_utf8_bytes'] as number;
    assert.ok(bytes > 0 && bytes < Buffer.byteLength(h.prompts()[0] ?? '', 'utf8'));
  } finally {
    await h.dispose();
  }
});

test('V5.1 — le prompt brut n’est jamais journalisé', async () => {
  const h = await harness();
  try {
    await propose(h);
    const raw = await readFile(h.paths.invocations, 'utf8');
    assert.equal(raw.includes(INFRA), false, 'aucune position dans le ledger');
    assert.equal(raw.includes(STATEMENT), false, 'aucun énoncé dans le ledger');
    assert.equal(raw.includes('CONTEXTE CANONIQUE'), false);
    // Ni ailleurs : aucun artefact de prompt n'est déposé.
    assert.equal(existsSync(h.paths.artifactsDir), false);
  } finally {
    await h.dispose();
  }
});

test('V5.1 — l’audit du contexte ne remplace pas derivation.inputs', async () => {
  const h = await harness();
  try {
    await propose(h);
    const raw = await readFile(h.paths.reconciliations, 'utf8');
    const entries = raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const proposed = entries.find((item) => item['kind'] === 'RECONCILIATION_PROPOSED');
    assert.ok(proposed, 'une proposition a bien été enregistrée');

    const derivation = proposed['derivation'] as { inputs?: readonly string[] };
    // `inputs` dit ce qui a été SOUMIS. Ni les événements, ni les preuves.
    assert.deepEqual([...(derivation.inputs ?? [])], [E1]);
    assert.equal((derivation.inputs ?? []).includes('evt_000003'), false);
    assert.equal((derivation.inputs ?? []).includes('add_000001'), false);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// C. Refus PRE-DISPATCH — le contexte hors borne ne coûte rien
// --------------------------------------------------------------------------

/** Contenu d'auteur assez grand pour porter le contexte au-delà de 128 KiB. */
const OVERSIZE = 'é'.repeat(70000);

test('V5.1 — un contexte hors borne est refusé avant TOUT engagement', async () => {
  const h = await harness({ authorContent: OVERSIZE });
  try {
    await assert.rejects(
      () => propose(h),
      (error: unknown) => isCcrError(error) && error.code === 'PROPOSAL_CONTEXT_TOO_LARGE',
    );

    // Zéro fournisseur, zéro invocation, zéro ledger.
    assert.equal(h.starts(), 0, 'aucun adaptateur appelé');
    assert.equal(h.resumes(), 0);
    assert.equal(existsSync(h.paths.invocations), false, 'aucun invocation_id, aucun ledger');
    assert.equal(existsSync(h.paths.usage), false, 'aucune observation d’usage');
    assert.equal(existsSync(h.paths.reconciliations), false, 'aucun append canonique');
  } finally {
    await h.dispose();
  }
});

test('V5.1 — la borne est vérifiée AVANT le quota', async () => {
  // Quota d'une seule invocation, déjà exhaustible, ET contexte hors borne :
  // si l'ordre était inversé, c'est le quota qui parlerait.
  const h = await harness({ authorContent: OVERSIZE, quota: 1 });
  try {
    await assert.rejects(
      () => propose(h),
      (error: unknown) => isCcrError(error) && error.code === 'PROPOSAL_CONTEXT_TOO_LARGE',
    );
    assert.equal(existsSync(h.paths.invocations), false);
  } finally {
    await h.dispose();
  }
});

test('V5.1 — juste sous la borne, la chaîne aboutit normalement', async () => {
  // Le même run, avec un contenu volumineux mais admissible : la borne ne
  // refuse pas par principe, elle refuse par mesure.
  const h = await harness({ authorContent: 'a'.repeat(60000) });
  try {
    await propose(h);
    assert.equal(h.starts(), 1);
    const records = await ledger(h);
    const bytes = records[0]?.['context_utf8_bytes'] as number;
    assert.ok(bytes > 60000 && bytes <= MAX_PROPOSAL_CONTEXT_UTF8_BYTES);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// D. Compatibilité des enregistrements antérieurs
// --------------------------------------------------------------------------

test('V5.1 — une invocation antérieure, sans audit, reste lisible', async () => {
  const h = await harness();
  try {
    // Forme exacte de `inv_000005` du run réel : version 4, aucun champ d'audit.
    await writeFile(h.paths.invocations, `${JSON.stringify({
      schema_version: 4, kind: 'DISPATCH_COMMITTED', invocation_id: 'inv_000001', run_id: RUN_ID,
      identity: { generation: 'NATIVE_V21_EXECUTION', expert_slot: 'author', provider: 'claude' },
      trigger_kind: 'RECONCILIATION_PROPOSAL',
      dispatch_committed_at: '2026-08-21T05:31:57.597Z',
    })}\n`, 'utf8');

    await propose(h);
    const records = await ledger(h);
    assert.equal(records.length, 2, 'l’ancienne ligne survit à la relecture');
    assert.equal(records[0]?.['invocation_id'], 'inv_000001');
    assert.equal(records[0]?.['context_sha256'], undefined, 'aucun audit inventé rétroactivement');
    assert.equal(typeof records[1]?.['context_sha256'], 'string', 'la nouvelle en porte un');
  } finally {
    await h.dispose();
  }
});
