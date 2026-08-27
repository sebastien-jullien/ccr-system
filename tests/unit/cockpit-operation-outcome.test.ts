/**
 * V5.1 — l'issue métier d'une opération longue survit jusqu'au reçu.
 *
 * Question de preuve :
 *
 * > **Une opération qui atteint réellement un fournisseur et n'enregistre rien
 * > peut-elle encore être lue comme un succès ?**
 *
 * Le run réel `CCR-20260404-001` a répondu oui, et c'est le défaut que ce
 * fichier ferme. Deux appels réels — Claude puis Codex — ont abouti, exit 0,
 * sortie reçue, aucun append canonique ; le reçu ne portait que
 * `status: SUCCEEDED`, et l'écran disait « effectuée ». L'issue exacte
 * — `INVALID_OUTPUT`, `VALID_ZERO`, `REVALIDATION_REFUSED` — n'était
 * récupérable nulle part.
 *
 * Quatre propriétés.
 *
 *  1. **Union close, projection totale.** Chacune des issues du §38.4 traverse
 *     le transport sous son propre nom, avec ses diagnostics publics.
 *  2. **Statut ≠ issue.** `SUCCEEDED` cohabite avec un refus métier ; une
 *     issue de domaine ne devient jamais une panne de transport.
 *  3. **Seul `RECORDED` écrit.** Les quatre autres laissent le journal V5
 *     inchangé, et le reçu sans révision.
 *  4. **Idempotence intacte.** Relire un reçu, le rejouer, le suivre : un seul
 *     appel fournisseur, quoi qu'il arrive.
 *
 * Aucun fournisseur réel : l'adaptateur est un double, et ce qu'il rend est
 * choisi par chaque test.
 *
 * ```text
 * CLAUDE_REAL_CALLS = 0    CODEX_REAL_CALLS = 0
 * ```
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { resolveCockpitDataRoot } from '../../src/cockpit/data-root.ts';
import {
  createOperationStore,
  newServerInstanceId,
  toPublicReceipt,
} from '../../src/cockpit/operations-store.ts';
import type { OperationReceipt, OperationStore } from '../../src/cockpit/operations-store.ts';
import { createLongOperationManager } from '../../src/cockpit/long-operations.ts';
import type { LongOperationManager } from '../../src/cockpit/long-operations.ts';
import {
  RECONCILIATION_MUTATION_ROUTE_SEGMENT,
  describeProposalOutcome,
  executeReconciliationMutation,
} from '../../src/cockpit/mutations-http.ts';
import type { MutationResponse } from '../../src/cockpit/mutations-http.ts';
import {
  MODEL_RECONCILIATION_PROPOSAL_DOMAIN_OUTCOMES,
  RECONCILIATION_PROPOSAL_OUTPUT_VERSION,
} from '../../src/services/reconciliation-proposer.ts';
import {
  CONTROVERSY_SCHEMA_VERSION,
  formatControversyEntryId,
  formatControversyId,
} from '../../src/core/controversy.ts';
import { readReconciliationJournal } from '../../src/store/reconciliation-store.ts';
import { runPaths } from '../../src/store/layout.ts';
import type { RunPaths } from '../../src/store/layout.ts';
import type { AgentAdapter, AgentTurnResult } from '../../src/adapters/agent-adapter.ts';
import type { AgentAdapters, RunServiceDeps } from '../../src/services/run-service.ts';

const RUN_ID = 'CCR-20260821-801';
const CTV = formatControversyId(1);
const E1 = formatControversyEntryId(1);
/** Bien formé, jamais soumis : de quoi refuser en phase C, pas à l'analyse. */
const E_ABSENT = formatControversyEntryId(9);

function envelope(scope: readonly string[]): string {
  return JSON.stringify({
    version: RECONCILIATION_PROPOSAL_OUTPUT_VERSION,
    target_controversy_id: CTV,
    proposals: [{ scope, options: [{ option_id: 'oa', content: 'option a' }] }],
  });
}

const OUTPUTS = {
  RECORDED: envelope([E1]),
  VALID_ZERO: JSON.stringify({
    version: RECONCILIATION_PROPOSAL_OUTPUT_VERSION,
    target_controversy_id: CTV,
    proposals: [],
  }),
  // Ce que G4 puis le run réel ont vu : du texte, pas une enveloppe.
  INVALID_OUTPUT: 'Voici ma proposition : je pense que les deux ont raison.',
  REVALIDATION_REFUSED: envelope([E_ABSENT]),
} as const;

/** Doubles d'adaptateurs, par racine — retrouvés par le serveur réel. */
const adapterFactories = new Map<string, () => AgentAdapters>();

interface Harness {
  readonly runsDir: string;
  readonly paths: RunPaths;
  readonly store: OperationStore;
  readonly manager: LongOperationManager;
  readonly deps: {
    runService: RunServiceDeps;
    store: OperationStore;
    manager: LongOperationManager;
  };
  say(output: string): void;
  fail(): void;
  calls(): number;
  dispose(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccr-v51-outcome-'));
  const dataRoot = await resolveCockpitDataRoot(dir);
  const runsDir = dataRoot.runsDir;
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.root, { recursive: true });

  await writeFile(paths.manifest, JSON.stringify({
    schema_version: 2, run_id: RUN_ID, created_at: '2026-08-21T09:00:00.000Z', title: 'v51-outcome',
    workspace: { cwd: runsDir },
    experts: {
      author: { provider: 'claude', session_id: 'S1' },
      challenger: { provider: 'codex', session_id: 'S2' },
    },
  }), 'utf8');
  await writeFile(paths.state, JSON.stringify({
    schema_version: 3, run_id: RUN_ID, state: 'READY', control: 'AUTOMATION', round: 1,
    active_expert_slot: null, next_step_source_slot: 'author', last_event_id: 'evt_000001',
    updated_at: '2026-08-21T09:00:00.000Z', pending_operation: null,
  }), 'utf8');
  await writeFile(paths.events, `${JSON.stringify({
    event_id: 'evt_000001', run_id: RUN_ID, round: 1, timestamp: '2026-08-21T09:10:00.000Z',
    actor: 'expert', type: 'assistant_response', expert_slot_id: 'author', session_id: 'S1',
    content: 'le défaut principal est infrastructurel',
  })}\n`, 'utf8');
  await writeFile(paths.controversies, `${JSON.stringify({
    schema_version: CONTROVERSY_SCHEMA_VERSION,
    entry_id: E1,
    controversy_id: CTV,
    kind: 'ASSERTION_RECORDED',
    semantic_origin: { kind: 'HUMAN' },
    recorded_by: 'HUMAN',
    recorded_at: '2026-08-21T09:30:00.000Z',
    round: 1,
    anchors: { provenance: [{ event_id: 'evt_000001', round: 1 }] },
  })}\n`, 'utf8');

  let output: string = OUTPUTS.RECORDED;
  let throws = false;
  let calls = 0;

  const adapter = (kind: 'claude' | 'codex'): AgentAdapter => ({
    kind,
    async start(): Promise<AgentTurnResult> {
      calls += 1;
      // Une panne fournisseur est une **exception**, pas une sortie vide : la
      // distinguer d'une sortie inexploitable est précisément l'enjeu.
      if (throws) throw new Error('le moteur n’a pas répondu');
      return {
        agent: kind,
        sessionId: `outcome-${kind}`,
        content: output,
        exitCode: 0,
        startedAt: '2026-08-21T10:00:00.000Z',
        completedAt: '2026-08-21T10:00:01.000Z',
        stdoutRaw: output,
        stderrRaw: '',
      };
    },
    resume(): never {
      throw new Error('jamais');
    },
    openInteractive(): never {
      throw new Error('jamais');
    },
  });

  const store = createOperationStore(dataRoot, newServerInstanceId());
  const manager = createLongOperationManager();
  const createAdapters = (): AgentAdapters =>
    ({ claude: adapter('claude'), codex: adapter('codex') }) as unknown as AgentAdapters;
  const runService: RunServiceDeps = {
    runsDir,
    now: () => new Date('2026-08-21T12:00:00.000Z'),
    createAdapters,
  };
  adapterFactories.set(runsDir, createAdapters);

  return {
    runsDir,
    paths,
    store,
    manager,
    deps: { runService, store, manager },
    say: (value: string) => {
      output = value;
    },
    fail: () => {
      throws = true;
    },
    calls: () => calls,
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
}

async function propose(h: Harness, key: string, slot = 'challenger'): Promise<MutationResponse> {
  return executeReconciliationMutation(h.deps, {
    routeSegment: RECONCILIATION_MUTATION_ROUTE_SEGMENT,
    runId: RUN_ID,
    generation: 'NATIVE_V21_EXECUTION',
    contentType: 'application/json',
    idempotencyKey: key,
    body: JSON.stringify({
      operation: 'PROPOSE_BY_MODEL',
      target_controversy_id: CTV,
      scope_kind: 'WHOLE',
      expert_slot: slot,
    }),
  });
}

/** Attend le reçu **terminal**, et le rend en entier — pas seulement son statut. */
async function settledReceipt(h: Harness, operationId: string): Promise<OperationReceipt> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const receipt = await h.store.read(operationId);
    if (receipt !== undefined && receipt.status !== 'RUNNING') return receipt;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('le reçu n’est jamais devenu terminal');
}

/** Traverse la chaîne complète, et rend le reçu **public** — celui du navigateur. */
async function outcomeOf(h: Harness, key: string): Promise<ReturnType<typeof toPublicReceipt>> {
  const response = await propose(h, key);
  assert.equal(response.status, 202, 'la requête n’est jamais maintenue ouverte');
  return toPublicReceipt(await settledReceipt(h, response.receipt.operation_id));
}

// --------------------------------------------------------------------------
// A. L'union close traverse le transport — une issue, un nom
// --------------------------------------------------------------------------

test('V5.1 — les six issues du §38.4, et rien d’autre', () => {
  // La liste du contrat est la seule autorité. Ce test échoue si une septième
  // issue apparaît sans que la projection soit revue.
  assert.deepEqual([...MODEL_RECONCILIATION_PROPOSAL_DOMAIN_OUTCOMES], [
    'RECORDED',
    'VALID_ZERO',
    'NOT_AVAILABLE',
    'INVALID_OUTPUT',
    'REVALIDATION_REFUSED',
    'PROVIDER_FAILED',
  ]);
});

test('V5.1 — la porte fermée reste une issue nommée, pas un silence', () => {
  // Projection pure, sans pipeline : `NOT_AVAILABLE` naît de la porte et non
  // d'un appel. La distinguer d'une panne est tout l'objet du §18.
  const projected = describeProposalOutcome({ kind: 'NOT_AVAILABLE', availability: 'NOT_AVAILABLE' });
  // Lu avant la comparaison : `deepEqual` restreint le type de `projected` à
  // celui de la valeur attendue, et masquerait ensuite le champ absent.
  assert.equal(projected.invocation_id, undefined, 'aucun engagement : aucune invocation');
  assert.deepEqual(projected, { outcome: 'NOT_AVAILABLE', reason: 'NOT_AVAILABLE' });
});

test('V5.1 — RECORDED : l’issue est nommée, et la révision accompagne l’écriture', async () => {
  const h = await harness();
  try {
    h.say(OUTPUTS.RECORDED);
    const receipt = await outcomeOf(h, 'ccr-outcome-recorded');

    assert.equal(receipt.status, 'SUCCEEDED');
    assert.equal(receipt.domain_outcome?.outcome, 'RECORDED');
    assert.equal(typeof receipt.domain_outcome?.invocation_id, 'string');
    // Seule l'issue qui écrit porte une révision — et dans son propre espace.
    assert.equal(typeof receipt.revision_after, 'string');
    assert.match(String(receipt.revision_after), /^rcn-sha256:/);

    const journal = await readReconciliationJournal(h.paths);
    assert.equal(journal.entries.length, 1);
    assert.equal(h.calls(), 1);
  } finally {
    await h.dispose();
  }
});

test('V5.1 — VALID_ZERO : le moteur n’a rien proposé, et ce n’est ni un refus ni une panne', async () => {
  const h = await harness();
  try {
    h.say(OUTPUTS.VALID_ZERO);
    const receipt = await outcomeOf(h, 'ccr-outcome-zero');

    assert.equal(receipt.status, 'SUCCEEDED');
    assert.equal(receipt.domain_outcome?.outcome, 'VALID_ZERO');
    // Ni motif de refus, ni code d'erreur : il n'y a rien à expliquer.
    assert.equal(receipt.domain_outcome?.reason, undefined);
    assert.equal(receipt.error_code, undefined);
    // Aucune écriture : `VALID_ZERO` n'est pas « zéro proposition enregistrée
    // parmi d'autres », c'est zéro tout court.
    assert.equal(receipt.revision_after, undefined);
    assert.equal((await readReconciliationJournal(h.paths)).entries.length, 0);
    // L'engagement, lui, reste inscrit.
    assert.equal(typeof receipt.domain_outcome?.invocation_id, 'string');
  } finally {
    await h.dispose();
  }
});

test('V5.1 — INVALID_OUTPUT : le fournisseur a répondu, le parseur a refusé, et le reçu le dit', async () => {
  const h = await harness();
  try {
    h.say(OUTPUTS.INVALID_OUTPUT);
    const receipt = await outcomeOf(h, 'ccr-outcome-invalid');

    // Le fournisseur a bien été atteint — c'est la forme exacte du run réel.
    assert.equal(h.calls(), 1);
    assert.equal(receipt.status, 'SUCCEEDED', 'la tâche s’est déroulée jusqu’au bout');
    assert.equal(receipt.domain_outcome?.outcome, 'INVALID_OUTPUT');
    // Les deux diagnostics publics du parseur strict, préservés.
    assert.equal(receipt.domain_outcome?.reason, 'OUTPUT_UNPARSABLE');
    assert.equal(typeof receipt.domain_outcome?.detail, 'string');
    assert.notEqual(receipt.domain_outcome?.detail, '');
    // Rien d'écrit, rien de rejoué.
    assert.equal(receipt.revision_after, undefined);
    assert.equal((await readReconciliationJournal(h.paths)).entries.length, 0);
  } finally {
    await h.dispose();
  }
});

test('V5.1 — REVALIDATION_REFUSED : nommée par son contrôle, distincte d’une panne', async () => {
  const h = await harness();
  try {
    // Enveloppe conforme, périmètre hors de l'ensemble soumis : l'analyse
    // passe, la phase C refuse. Aucune concurrence n'est simulée.
    h.say(OUTPUTS.REVALIDATION_REFUSED);
    const receipt = await outcomeOf(h, 'ccr-outcome-revalidation');

    assert.equal(receipt.status, 'SUCCEEDED');
    assert.equal(receipt.domain_outcome?.outcome, 'REVALIDATION_REFUSED');
    // `SCOPE`, et non `SUBMITTED_SET` : la porte de périmètre `S4` refuse
    // l'unité inconnue avant que l'appartenance à l'ensemble soumis ne soit
    // examinée. Les deux contrôles sont réels ; celui qui parle ici est le
    // premier des quatre à refuser, et le reçu porte son nom exact.
    assert.equal(receipt.domain_outcome?.reason, 'SCOPE');
    assert.equal(typeof receipt.domain_outcome?.detail, 'string');
    assert.equal(receipt.revision_after, undefined);
    assert.equal((await readReconciliationJournal(h.paths)).entries.length, 0);
  } finally {
    await h.dispose();
  }
});

test('V5.1 — PROVIDER_FAILED : l’appel n’a pas abouti, l’engagement reste inscrit', async () => {
  const h = await harness();
  try {
    h.fail();
    const receipt = await outcomeOf(h, 'ccr-outcome-provider');

    assert.equal(h.calls(), 1, 'un seul essai — aucune reprise implicite');
    // Une issue métier ne devient pas une panne de transport : le statut reste
    // celui d'une tâche qui s'est déroulée, et le refus est nommé ailleurs.
    assert.equal(receipt.status, 'SUCCEEDED');
    assert.equal(receipt.error_code, undefined);
    assert.equal(receipt.domain_outcome?.outcome, 'PROVIDER_FAILED');
    assert.equal(typeof receipt.domain_outcome?.reason, 'string');
    // « L'engagement reste inscrit » doit être vérifiable, donc référencé.
    assert.equal(typeof receipt.domain_outcome?.invocation_id, 'string');
    assert.equal(receipt.revision_after, undefined);
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// B. Statut d'exécution ≠ issue métier
// --------------------------------------------------------------------------

test('V5.1 — quatre issues sur cinq réussissent l’opération sans rien enregistrer', async () => {
  const cases = [
    ['VALID_ZERO', OUTPUTS.VALID_ZERO],
    ['INVALID_OUTPUT', OUTPUTS.INVALID_OUTPUT],
    ['REVALIDATION_REFUSED', OUTPUTS.REVALIDATION_REFUSED],
  ] as const;

  const seen: string[] = [];
  for (const [expected, output] of cases) {
    const h = await harness();
    try {
      h.say(output);
      const receipt = await outcomeOf(h, `ccr-distinct-${expected}`);
      seen.push(String(receipt.domain_outcome?.outcome));
      // La propriété centrale : `SUCCEEDED` ne prouve **jamais** un
      // enregistrement. C'est ce que l'écran affirmait à tort.
      assert.equal(receipt.status, 'SUCCEEDED');
      assert.equal(receipt.revision_after, undefined);
      assert.equal((await readReconciliationJournal(h.paths)).entries.length, 0);
    } finally {
      await h.dispose();
    }
  }

  // Trois issues, trois noms : aucune n'est absorbée par une autre.
  assert.deepEqual(seen, ['VALID_ZERO', 'INVALID_OUTPUT', 'REVALIDATION_REFUSED']);
  assert.equal(new Set(seen).size, 3);
});

// --------------------------------------------------------------------------
// C. Idempotence — le suivi ne coûte jamais un second appel
// --------------------------------------------------------------------------

test('V5.1 — relire N fois un reçu de refus n’appelle aucun fournisseur', async () => {
  const h = await harness();
  try {
    h.say(OUTPUTS.INVALID_OUTPUT);
    const response = await propose(h, 'ccr-outcome-poll');
    const operationId = response.receipt.operation_id;
    await settledReceipt(h, operationId);

    // Ce que fait le suivi automatique : lire, encore et encore.
    for (let read = 0; read < 12; read += 1) {
      const receipt = await h.store.read(operationId);
      assert.equal(receipt?.status, 'SUCCEEDED');
      assert.equal(receipt?.domain_outcome?.outcome, 'INVALID_OUTPUT');
    }
    assert.equal(h.calls(), 1, 'douze lectures, un seul appel fournisseur');

    // Et une retransmission de la MÊME intention rend le même verdict.
    const replay = await propose(h, 'ccr-outcome-poll');
    assert.equal(replay.receipt.operation_id, operationId);
    assert.equal(replay.receipt.domain_outcome?.outcome, 'INVALID_OUTPUT');
    assert.equal(h.calls(), 1, 'la retransmission n’a rappelé aucun fournisseur');
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// D. La couche HTTP — l'issue traverse la vraie socket
// --------------------------------------------------------------------------

interface HttpResult {
  readonly status: number;
  readonly body: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

function httpRequest(
  port: number,
  method: string,
  target: string,
  options: { cookie?: string; origin?: string; key?: string; body?: string } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: `127.0.0.1:${String(port)}` };
    if (options.cookie !== undefined) headers['Cookie'] = options.cookie;
    if (options.origin !== undefined) headers['Origin'] = options.origin;
    if (options.key !== undefined) headers['Idempotency-Key'] = options.key;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(options.body, 'utf8'));
    }
    const req = request({ host: '127.0.0.1', port, method, path: target, headers }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        raw += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw, headers: res.headers }));
    });
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

test('V5.1 — `GET /api/operations/:id` rend l’issue métier au navigateur', async () => {
  const h = await harness();
  const { startCockpit } = await import('../../src/cockpit/cockpit-service.ts');
  // Le serveur réel, avec des adaptateurs doublés : la chaîne HTTP complète,
  // sans le moindre fournisseur.
  const instance = await startCockpit({
    runsDir: h.runsDir,
    port: 0,
    depsOverrides: { createAdapters: adapterFactories.get(h.runsDir) },
  } as Parameters<typeof startCockpit>[0]);
  const port = instance.server.port;
  const origin = `http://127.0.0.1:${String(port)}`;

  try {
    h.say(OUTPUTS.INVALID_OUTPUT);
    const shell = await httpRequest(port, 'GET', '/');
    const setCookie = shell.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0] ?? '';
    assert.ok(cookie.length > 0);

    const accepted = await httpRequest(port, 'POST', `/api/runs/${RUN_ID}/reconciliations`, {
      cookie,
      origin,
      key: 'ccr-http-outcome',
      body: JSON.stringify({
        operation: 'PROPOSE_BY_MODEL',
        target_controversy_id: CTV,
        scope_kind: 'WHOLE',
        expert_slot: 'author',
      }),
    });
    assert.equal(accepted.status, 202);
    const operationId = String((JSON.parse(accepted.body) as { operation_id: string }).operation_id);

    // Ce que fait le suivi automatique du navigateur, à l'identique.
    let payload: Record<string, unknown> = {};
    for (let read = 0; read < 400; read += 1) {
      const polled = await httpRequest(port, 'GET', `/api/operations/${operationId}`, { cookie });
      assert.equal(polled.status, 200);
      payload = JSON.parse(polled.body) as Record<string, unknown>;
      if (payload['status'] !== 'RUNNING') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    assert.equal(payload['status'], 'SUCCEEDED');
    const domain = payload['domain_outcome'] as Record<string, unknown> | undefined;
    assert.notEqual(domain, undefined, 'l’issue a traversé la socket');
    assert.equal(domain?.['outcome'], 'INVALID_OUTPUT');
    assert.equal(domain?.['reason'], 'OUTPUT_UNPARSABLE');
    assert.equal(typeof domain?.['invocation_id'], 'string');
    // Le reçu public ne fuit ni empreinte, ni instance de serveur, ni chemin.
    assert.equal(payload['fingerprint'], undefined);
    assert.equal(payload['server_instance_id'], undefined);
    assert.equal(h.calls(), 1, 'un seul appel, malgré toutes ces lectures');
  } finally {
    await instance.stop();
    await h.dispose();
  }
});

test('V5.1 — un reçu antérieur au champ reste lisible, et ne devient pas un succès métier', async () => {
  const h = await harness();
  try {
    // Reçu d'avant la réparation : même version de schéma, terminé sans issue
    // métier. C'est exactement la forme des deux reçus du run réel
    // `CCR-20260404-001`, qui ne doivent ni devenir illisibles, ni se voir
    // attribuer rétroactivement une issue que personne n'a observée.
    const claim = await h.store.claim({
      idempotencyKey: 'ccr-outcome-legacy',
      fingerprint: 'sha256:legacy',
      runId: RUN_ID,
      action: 'RECONCILIATION:PROPOSE_BY_MODEL',
    });
    const operationId = claim.receipt.operation_id;

    const legacy = await h.store.settle(operationId, { status: 'SUCCEEDED' });
    assert.equal(legacy.status, 'SUCCEEDED');
    assert.equal(legacy.domain_outcome, undefined);

    // Relu depuis le disque : lisible sous la même version de schéma, et
    // toujours sans issue. Une absence reste une absence.
    const reread = await h.store.read(operationId);
    assert.equal(reread?.status, 'SUCCEEDED');
    assert.equal(reread?.domain_outcome, undefined);
    assert.equal(toPublicReceipt(reread as OperationReceipt).domain_outcome, undefined);
    assert.equal(h.calls(), 0, 'aucun fournisseur n’a été atteint par ce scénario');
  } finally {
    await h.dispose();
  }
});
