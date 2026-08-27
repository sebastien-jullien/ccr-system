/**
 * Preuves de la tranche S13 — section 3/3, la porte de disponibilité.
 *
 * La porte a été OUVERTE par décision produit humaine le 2026-08-21. La question
 * de preuve du fichier suit ce déplacement :
 *
 * > **Une porte ouverte mène-t-elle au chemin normal, et à rien de plus — sans
 * > que la disponibilité devienne une autorité, une décision, ou une cause
 * > technique que CCR n'a pas observée ?**
 *
 * ```text
 * IMPLEMENTED  ≠  AVAILABLE        NOT_AVAILABLE  ≠  PROVIDER_FAILED
 * AVAILABLE    ≠  AUTORITÉ         PROPOSITION    ≠  DÉCISION
 * REAL_PROVIDER_CALLS = 0          adaptateurs doublés, jamais un fournisseur réel
 * ```
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { isCcrError } from '../../src/core/errors.ts';
import {
  CONTROVERSY_SCHEMA_VERSION,
  formatControversyEntryId,
  formatControversyId,
  validateControversyEntry,
} from '../../src/core/controversy.ts';
import type { ControversyEntry } from '../../src/core/controversy.ts';
import type { AgentAdapter, AgentTurnResult } from '../../src/adapters/agent-adapter.ts';
import { runPaths } from '../../src/store/layout.ts';
import type { RunPaths } from '../../src/store/layout.ts';
import {
  MODEL_RECONCILIATION_PROPOSAL_DOMAIN_OUTCOMES,
  MODEL_RECONCILIATION_PROPOSAL_IMPLEMENTED,
  MODEL_RECONCILIATION_PROPOSAL_RUNTIME_AVAILABILITY,
  RECONCILIATION_PROPOSAL_OUTPUT_VERSION,
  requestModelReconciliationProposal,
  runControlledAcceptanceProposal,
} from '../../src/services/reconciliation-proposer.ts';
import type {
  ReconciliationProposalAvailability,
  ReconciliationProposalRequest,
  ReconciliationProposerDeps,
} from '../../src/services/reconciliation-proposer.ts';

const RUN_ID = 'CCR-20260820-914';
const CTV = formatControversyId(1);
const E1 = formatControversyEntryId(1);
const E2 = formatControversyEntryId(2);

const EVENTS = [
  {
    event_id: 'evt_000001',
    run_id: RUN_ID,
    round: 1,
    timestamp: '2026-08-20T09:10:00.000Z',
    actor: 'expert',
    type: 'assistant_response',
    expert_slot_id: 'author',
    session_id: 'S1',
    content: 'Le cache doit expirer rapidement.',
  },
];

function unit(sequence: number): ControversyEntry {
  return validateControversyEntry({
    schema_version: CONTROVERSY_SCHEMA_VERSION,
    entry_id: formatControversyEntryId(sequence),
    controversy_id: CTV,
    kind: sequence === 1 ? 'CONTROVERSY_RECORDED' : 'ASSERTION_RECORDED',
    semantic_origin: { kind: 'SOURCE', actor: 'author' },
    recorded_by: 'CCR',
    recorded_at: '2026-08-20T09:30:00.000Z',
    round: 1,
    anchors: { provenance: [{ event_id: 'evt_000001', round: 1 }] },
  } as ControversyEntry);
}

interface Harness {
  readonly runsDir: string;
  readonly paths: RunPaths;
  readonly deps: ReconciliationProposerDeps;
  calls(): number;
  dispose(): Promise<void>;
}

function fakeAdapter(kind: 'claude' | 'codex', calls: string[], content: string): AgentAdapter {
  return {
    kind,
    async start(prompt: string): Promise<AgentTurnResult> {
      calls.push(prompt);
      return {
        agent: kind,
        sessionId: `propose-${kind}-1`,
        content,
        exitCode: 0,
        startedAt: '2026-08-20T10:00:00.000Z',
        completedAt: '2026-08-20T10:00:01.000Z',
        stdoutRaw: content,
        stderrRaw: '',
      };
    },
    resume(): never {
      throw new Error("une proposition assistée ne reprend jamais la session d'un expert");
    },
    openInteractive(): never {
      throw new Error("une proposition assistée n'ouvre aucun terminal");
    },
  };
}

async function harness(content = ''): Promise<Harness> {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'ccr-v5-s13c-'));
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.root, { recursive: true });
  await writeFile(
    paths.manifest,
    JSON.stringify({
      schema_version: 2,
      run_id: RUN_ID,
      created_at: '2026-08-20T09:00:00.000Z',
      title: 'S13-C',
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
      updated_at: '2026-08-20T09:00:00.000Z',
      pending_operation: null,
    }),
    'utf8',
  );
  await writeFile(paths.events, EVENTS.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  await writeFile(
    paths.controversies,
    [unit(1), unit(2)].map((e) => JSON.stringify(e)).join('\n') + '\n',
    'utf8',
  );

  const calls: string[] = [];
  const adapters = {
    claude: fakeAdapter('claude', calls, content),
    codex: fakeAdapter('codex', calls, content),
  };
  let tick = 0;
  return {
    runsDir,
    paths,
    deps: {
      runsDir,
      now: () => {
        tick += 1;
        return new Date(Date.UTC(2026, 7, 20, 12, 0, tick));
      },
      createAdapters: () => adapters,
    },
    calls: () => calls.length,
    dispose: () => rm(runsDir, { recursive: true, force: true }),
  };
}

const REQUEST: ReconciliationProposalRequest = {
  runId: RUN_ID,
  target_controversy_id: CTV,
  scope_kind: 'SUBSET',
  scope: [E1, E2],
  expert_slot: 'challenger',
};

const VALID_OUTPUT = JSON.stringify({
  version: RECONCILIATION_PROPOSAL_OUTPUT_VERSION,
  target_controversy_id: CTV,
  proposals: [{ scope: [E1], options: [{ option_id: 'oa', content: 'option a' }] }],
});

// --------------------------------------------------------------------------
// Vocabulaire
// --------------------------------------------------------------------------

/**
 * Observe la disponibilité **sous son type contractuel** — l'union fermée
 * `'NOT_AVAILABLE' | 'AVAILABLE'` déclarée par le service — plutôt que sous le
 * type littéral que le compilateur déduit de l'initialisation de la constante.
 *
 * La fonction ne convertit rien, n'élargit aucune valeur, n'invente aucune
 * branche : elle retourne exactement ce qu'elle reçoit. Elle existe pour que
 * l'assertion suivante continue d'éprouver **au runtime** une propriété que le
 * compilateur croit déjà acquise. Ce que le compilateur tient pour impossible
 * aujourd'hui, une modification du service le rendra possible demain — et c'est
 * précisément ce jour-là que le test doit parler.
 *
 * `TYPE NARROWING ≠ COMPILER BYPASS` : le paramètre porte le type autoritaire,
 * aucun `as`, aucun `!`, aucune directive de suppression.
 */
function observedAvailability(
  value: ReconciliationProposalAvailability,
): ReconciliationProposalAvailability {
  return value;
}

test('V5.1 — la porte publique est OUVERTE par décision produit, et reste un fait distinct', () => {
  const availability = observedAvailability(MODEL_RECONCILIATION_PROPOSAL_RUNTIME_AVAILABILITY);
  assert.equal(availability, 'AVAILABLE');
  assert.notEqual(availability, 'NOT_AVAILABLE');

  // Les deux faits restent INDÉPENDANTS, et le sens de leur indépendance n'a pas
  // changé : la capacité existait avant l'ouverture — `S13` l'avait livrée — et
  // l'ouverture est une décision humaine, jamais une conséquence du code.
  assert.equal(MODEL_RECONCILIATION_PROPOSAL_IMPLEMENTED, true);
});

test('S13 — les six issues de domaine du §38.4, ensemble fermé', () => {
  assert.deepEqual([...MODEL_RECONCILIATION_PROPOSAL_DOMAIN_OUTCOMES], [
    'RECORDED',
    'VALID_ZERO',
    'NOT_AVAILABLE',
    'INVALID_OUTPUT',
    'REVALIDATION_REFUSED',
    'PROVIDER_FAILED',
  ]);
  // Le contrat n'emploie pas `SUCCESS`, et aucune septième issue n'existe.
  for (const absent of ['SUCCESS', 'PARTIAL', 'RETRYING', 'RECOVERING', 'UNKNOWN_AFTER_COMMITMENT']) {
    assert.equal(
      (MODEL_RECONCILIATION_PROPOSAL_DOMAIN_OUTCOMES as readonly string[]).includes(absent),
      false,
      absent,
    );
  }
});

// --------------------------------------------------------------------------
// Une porte ouverte mène au chemin normal — et à rien de plus
// --------------------------------------------------------------------------

test('V5.1 — porte ouverte : le chemin normal engage, appelle une fois, enregistre', async () => {
  const h = await harness(VALID_OUTPUT);
  try {
    const before = await readFile(h.paths.controversies, 'utf8');
    const outcome = await requestModelReconciliationProposal(h.deps, REQUEST);

    assert.equal(outcome.kind, 'DISPATCHED');
    if (outcome.kind !== 'DISPATCHED') throw new Error('inatteignable');
    assert.equal(outcome.proposal.kind, 'RECORDED');
    // La branche ouverte porte l'issue du pipeline, et rien d'autre : aucune
    // disponibilité résiduelle ne s'y invite.
    assert.deepEqual(Object.keys(outcome).sort(), ['kind', 'proposal']);
    assert.equal('availability' in outcome, false);

    // UN seul appel — ni reprise, ni second essai — et la gouvernance a bien
    // été traversée avant lui.
    assert.equal(h.calls(), 1);
    assert.ok(existsSync(h.paths.invocations), 'engagement durable écrit');
    assert.ok(existsSync(h.paths.reconciliations), 'proposition CCR enregistrée');
    // Le journal V3 n'est pas touché : proposer n'est ni contester, ni décider.
    assert.equal(await readFile(h.paths.controversies, 'utf8'), before);
  } finally {
    await h.dispose();
  }
});

test('V5.1 — ouvrir la porte ne fabrique aucune cause technique', async () => {
  const h = await harness(VALID_OUTPUT);
  try {
    const outcome = await requestModelReconciliationProposal(h.deps, REQUEST);
    if (outcome.kind !== 'DISPATCHED') throw new Error('inatteignable');
    // L'issue ne porte aucun champ suggérant une cause que CCR n'a pas observée.
    for (const forbidden of [
      'error',
      'error_code',
      'reason',
      'quota',
      'provider',
      'retry_after',
      'unknown',
    ]) {
      assert.equal(forbidden in outcome, false, forbidden);
    }
    // Et la distinction que la porte fermée protégeait demeure dans le domaine :
    // un refus de disponibilité n'a jamais été une panne de fournisseur, et les
    // deux issues restent deux valeurs distinctes du §38.4.
    const outcomes = MODEL_RECONCILIATION_PROPOSAL_DOMAIN_OUTCOMES as readonly string[];
    assert.ok(outcomes.includes('NOT_AVAILABLE'), 'NOT_AVAILABLE demeure une issue de domaine');
    assert.ok(outcomes.includes('PROVIDER_FAILED'), 'PROVIDER_FAILED demeure une issue distincte');
    assert.notEqual(
      outcomes.indexOf('NOT_AVAILABLE'),
      outcomes.indexOf('PROVIDER_FAILED'),
      'deux issues, deux positions — jamais un synonyme',
    );
  } finally {
    await h.dispose();
  }
});

test('V5.1 — la voie publique et la voie d\'acceptation aboutissent au même résultat', async () => {
  const h = await harness(VALID_OUTPUT);
  try {
    // Ouvrir la porte n'a pas créé une seconde sémantique à côté de la première :
    // sur la MÊME requête, les deux voies rendent la même issue de domaine.
    const publique = await requestModelReconciliationProposal(h.deps, REQUEST);
    if (publique.kind !== 'DISPATCHED') throw new Error('inatteignable');

    const accepted = await runControlledAcceptanceProposal(h.deps, REQUEST, {
      gate: 'G4_REAL_PROPOSAL_ACCEPTANCE',
      humanAuthorization: 'gate S13 — fixture déterministe, aucun fournisseur réel',
    });
    assert.equal(publique.proposal.kind, 'RECORDED');
    assert.equal(accepted.kind, 'RECORDED');
    assert.equal(h.calls(), 2, 'un appel par voie, jamais davantage');
  } finally {
    await h.dispose();
  }
});

// --------------------------------------------------------------------------
// La voie d'acceptation
// --------------------------------------------------------------------------

test('S13 — la voie d\'acceptation exige son autorisation, et ne se devine pas', async () => {
  const h = await harness(VALID_OUTPUT);
  try {
    for (const authorization of [
      { gate: 'AUTRE_GATE', humanAuthorization: 'x' },
      { gate: 'G4_REAL_PROPOSAL_ACCEPTANCE', humanAuthorization: '' },
    ]) {
      await assert.rejects(
        () =>
          runControlledAcceptanceProposal(
            h.deps,
            REQUEST,
            authorization as Parameters<typeof runControlledAcceptanceProposal>[2],
          ),
        (error: unknown) =>
          isCcrError(error) &&
          (error.details as { reason?: string } | undefined)?.reason ===
            'ACCEPTANCE_AUTHORIZATION_REQUIRED',
      );
    }
    // Un refus d'autorisation ne coûte rien non plus.
    assert.equal(h.calls(), 0);
    assert.equal(existsSync(h.paths.invocations), false);
  } finally {
    await h.dispose();
  }
});

test('S13 — la voie d\'acceptation ne franchit QUE la porte publique', async () => {
  // Elle ne dispense d'aucune gouvernance : le périmètre est validé, et un
  // périmètre invalide la refuse exactement comme la voie publique le ferait.
  const h = await harness(VALID_OUTPUT);
  try {
    await assert.rejects(
      () =>
        runControlledAcceptanceProposal(
          h.deps,
          { ...REQUEST, scope: [formatControversyEntryId(99)] },
          {
            gate: 'G4_REAL_PROPOSAL_ACCEPTANCE',
            humanAuthorization: 'gate S13 — fixture',
          },
        ),
      (error: unknown) => isCcrError(error),
    );
    assert.equal(h.calls(), 0);
    assert.equal(existsSync(h.paths.invocations), false);
  } finally {
    await h.dispose();
  }
});

test('V5.1 — la disponibilité reste service-autoritaire : aucun champ d\'appel ne la calcule', async () => {
  const h = await harness(VALID_OUTPUT);
  try {
    // La propriété n'a pas changé de nature, seulement de sens de lecture : hier
    // aucun champ ne pouvait OUVRIR la porte, aujourd'hui aucun ne peut la
    // REFERMER. La valeur est une constante de module, et seule une décision
    // humaine inscrite dans le code la change.
    const withExtras = {
      ...REQUEST,
      available: false,
      force: false,
      availability: 'NOT_AVAILABLE',
    } as unknown as ReconciliationProposalRequest;
    const outcome = await requestModelReconciliationProposal(h.deps, withExtras);
    assert.equal(outcome.kind, 'DISPATCHED');
    assert.equal(h.calls(), 1);
  } finally {
    await h.dispose();
  }
});
