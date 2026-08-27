/**
 * Classification de vivacité (V2-IMP-30, Slice 0C) — fermeture de `CLX2-A1`.
 *
 * Le défaut : le seul signal exposé par les services,
 *
 *   requiresRecovery = state === 'WAITING_AGENT' || pending_operation !== null
 *
 * est vrai pendant **chaque tour agent normal**, parce que CCR persiste
 * exactement ces deux conditions avant tout appel fournisseur. Un cockpit
 * afficherait donc « récupération nécessaire » pendant une opération saine,
 * proposerait une remédiation, et celle-ci échouerait sur le verrou.
 *
 * La correction n'est pas de deviner : c'est d'exiger des faits opérationnels
 * explicites, et de dire « je ne sais pas » lorsqu'ils manquent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NO_EVIDENCE,
  classifyRunLiveness,
  needsHumanAttention,
} from '../../src/core/run-liveness.ts';
import type { RunExecutionEvidence } from '../../src/core/run-liveness.ts';
import { MANIFEST_SCHEMA_VERSION, STATE_SCHEMA_VERSION } from '../../src/core/run.ts';
import type { PendingOperation, RunManifest, RunStateDocument } from '../../src/core/run.ts';
import type { ControlOwner, RunState } from '../../src/core/state.ts';
import { TEST_RUNTIME_CONFIG } from '../helpers/runtime-config.ts';

const RUN_ID = 'CCR-20260402-001';

function manifestOf(claude: string | null, codex: string | null): RunManifest {
  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    run_id: RUN_ID,
    title: 'T',
    created_at: '2026-08-08T00:00:00.000Z',
    workspace: { cwd: 'E:/prog/exemple' },
    agents: {
      claude: { session_id: claude, role: 'challenger' },
      codex: { session_id: codex, role: 'author' },
    },
    runtime_config: TEST_RUNTIME_CONFIG,
  };
}

const PENDING: PendingOperation = {
  kind: 'step',
  agent: 'claude',
  round: 1,
  prompt_event_id: 'evt_000004',
  source_event_id: 'evt_000003',
  session_id: 'claude-1',
  return_state: 'READY',
  return_control: 'AUTOMATION',
  started_at: '2026-08-08T00:00:00.000Z',
};

function stateOf(
  state: RunState,
  control: ControlOwner = 'AUTOMATION',
  pending: PendingOperation | null = null,
): RunStateDocument {
  return {
    schema_version: STATE_SCHEMA_VERSION,
    run_id: RUN_ID,
    state,
    control,
    round: 1,
    active_agent: null,
    last_event_id: 'evt_000003',
    pending_operation: pending,
    uncertainty: null,
    updated_at: '2026-08-08T00:00:00.000Z',
  };
}

const BOTH = manifestOf('claude-1', 'codex-1');

function evidence(over: Partial<RunExecutionEvidence>): RunExecutionEvidence {
  return { ...NO_EVIDENCE, ...over };
}

// --------------------------------------------------------------------------
// (35, 36) La règle prioritaire : une opération vivante n'est pas un incident
// --------------------------------------------------------------------------

test('(35) WAITING_AGENT + pending + opération démontrée active → OPERATION_IN_FLIGHT', () => {
  const facts = { manifest: BOTH, state: stateOf('WAITING_AGENT', 'AUTOMATION', PENDING), pendingResponseJournaled: false };

  // Preuve par le registre de l'hôte.
  const byRegistry = classifyRunLiveness(
    facts,
    evidence({ hostOperation: 'ACTIVE', pendingCoveredByLock: 'YES' }),
  );
  assert.equal(byRegistry.liveness, 'OPERATION_IN_FLIGHT');
  assert.equal(byRegistry.basis, 'HOST_REGISTRY_ACTIVE');

  // Preuve par le verrou détenu par un autre processus vivant — à condition
  // que ce verrou puisse être celui de l'opération observée (V2-IMP-31).
  const byLock = classifyRunLiveness(
    facts,
    evidence({ lock: 'ALIVE_OTHER_PROCESS', pendingCoveredByLock: 'YES' }),
  );
  assert.equal(byLock.liveness, 'OPERATION_IN_FLIGHT');
  assert.equal(byLock.basis, 'LOCK_HELD_BY_OTHER_PROCESS');

  // Et dans les deux cas, aucune intervention humaine n'est suggérée.
  assert.equal(needsHumanAttention(byRegistry.liveness), false);
  assert.equal(needsHumanAttention(byLock.liveness), false);
});

test('(36) mêmes faits sans évidence d’activité : jamais IN_FLIGHT par défaut', () => {
  const facts = { manifest: BOTH, state: stateOf('WAITING_AGENT', 'AUTOMATION', PENDING), pendingResponseJournaled: false };

  // Aucun propriétaire vivant, aucune réponse journalisée : c'est le cas que
  // `ccr recover` matérialise comme ambigu — CCR ne sait pas si le tour a eu lieu.
  const abandonedNoResponse = classifyRunLiveness(facts, evidence({ lock: 'ABSENT' }));
  assert.equal(abandonedNoResponse.liveness, 'AMBIGUOUS');
  assert.equal(abandonedNoResponse.basis, 'NO_LIVE_OWNER_NO_RESPONSE');

  // Réponse déjà journalisée : `ccr recover` finalise sans rappeler l'agent.
  const finalizable = classifyRunLiveness(
    { ...facts, pendingResponseJournaled: true },
    evidence({ lock: 'ABSENT' }),
  );
  assert.equal(finalizable.liveness, 'ABANDONED_OPERATION');
  assert.equal(finalizable.basis, 'NO_LIVE_OWNER_RESPONSE_JOURNALED');

  // Sans aucune observation : la classification l'admet au lieu de conclure.
  const blind = classifyRunLiveness(facts, NO_EVIDENCE);
  assert.equal(blind.liveness, 'UNDETERMINED');
  assert.equal(blind.basis, 'EVIDENCE_INSUFFICIENT');
  assert.equal(needsHumanAttention('UNDETERMINED'), false, 'ne pas savoir n’est pas un incident');
});

// --------------------------------------------------------------------------
// (37 à 39) Cas canoniques
// --------------------------------------------------------------------------

test('(37) FAILED_INITIALIZATION incomplet → PARTIAL_INITIALIZATION, une session ou aucune', () => {
  const partial = classifyRunLiveness(
    { manifest: manifestOf('claude-1', null), state: stateOf('FAILED_INITIALIZATION'), pendingResponseJournaled: false },
    NO_EVIDENCE,
  );
  assert.equal(partial.liveness, 'PARTIAL_INITIALIZATION');
  assert.equal(partial.basis, 'PARTIAL_SESSIONS');
  assert.equal(needsHumanAttention(partial.liveness), true);

  /**
   * V2.1-REPAIR — zéro session.
   *
   * Ce cas affirmait auparavant qu'un run sans aucune session n'est pas une
   * initialisation *partielle*. Littéralement vrai, et opérationnellement faux :
   * la vivacité répond à « faut-il intervenir ? », pas à « le mot partiel
   * s'applique-t-il ? ». L'échec du premier agent — le cas nominal — laisse deux
   * sessions manquantes, et `planCanonicalRecovery` comme `recoverRunLocked` le
   * tiennent pour récupérable.
   *
   * `PARTIAL_INITIALIZATION` est donc un statut de vivacité : initialisation
   * incomplète et récupérable.
   */
  const manifest = manifestOf(null, null);
  assert.equal(manifest.agents.claude.session_id, null, 'aucune session claude');
  assert.equal(manifest.agents.codex.session_id, null, 'aucune session codex');

  const zero = classifyRunLiveness(
    { manifest, state: stateOf('FAILED_INITIALIZATION'), pendingResponseJournaled: false },
    NO_EVIDENCE,
  );
  assert.equal(zero.liveness, 'PARTIAL_INITIALIZATION');
  assert.equal(zero.basis, 'PARTIAL_SESSIONS');
  assert.equal(needsHumanAttention(zero.liveness), true);

  // Deux sessions présentes : plus rien n'est incomplet.
  const complete = classifyRunLiveness(
    {
      manifest: manifestOf('claude-1', 'codex-1'),
      state: stateOf('FAILED_INITIALIZATION'),
      pendingResponseJournaled: false,
    },
    NO_EVIDENCE,
  );
  assert.notEqual(complete.liveness, 'PARTIAL_INITIALIZATION');
});

test('(38) READY normal → NONE', () => {
  const verdict = classifyRunLiveness(
    { manifest: BOTH, state: stateOf('READY'), pendingResponseJournaled: false },
    NO_EVIDENCE,
  );
  assert.equal(verdict.liveness, 'NONE');
  assert.equal(verdict.basis, 'NO_PENDING_WORK');
  assert.equal(needsHumanAttention(verdict.liveness), false);
});

test('(39) PAUSED / HUMAN normal → NONE, sauf fait contraire', () => {
  const paused = classifyRunLiveness(
    { manifest: BOTH, state: stateOf('PAUSED', 'HUMAN'), pendingResponseJournaled: false },
    NO_EVIDENCE,
  );
  assert.equal(paused.liveness, 'NONE');

  // Fait contraire : un verrou périmé subsiste sur ce run suspendu.
  const withStale = classifyRunLiveness(
    { manifest: BOTH, state: stateOf('PAUSED', 'HUMAN', PENDING), pendingResponseJournaled: false },
    evidence({ lock: 'STALE' }),
  );
  assert.equal(withStale.liveness, 'ORPHAN_LOCK');
});

// --------------------------------------------------------------------------
// (40, 41) Évidences synthétiques
// --------------------------------------------------------------------------

test('(40) verrou périmé → ORPHAN_LOCK', () => {
  const stale = classifyRunLiveness(
    { manifest: BOTH, state: stateOf('WAITING_AGENT', 'AUTOMATION', PENDING), pendingResponseJournaled: true },
    evidence({ lock: 'STALE' }),
  );
  assert.equal(stale.liveness, 'ORPHAN_LOCK');
  assert.equal(stale.basis, 'STALE_LOCK_OBSERVED');

  // Verrou du processus courant SANS opération correspondante : c'est la
  // situation du serveur long-lived. Décidable seulement avec un registre —
  // dont l'implémentation réelle appartient au Slice 0D.
  const selfOrphan = classifyRunLiveness(
    { manifest: BOTH, state: stateOf('WAITING_AGENT', 'AUTOMATION', PENDING), pendingResponseJournaled: false },
    evidence({ lock: 'ALIVE_THIS_PROCESS', hostOperation: 'NONE' }),
  );
  assert.equal(selfOrphan.liveness, 'ORPHAN_LOCK');
  assert.equal(selfOrphan.basis, 'LOCK_THIS_PROCESS_WITHOUT_HOST_OPERATION');

  // Le même verrou, sans réponse du registre, reste indécidable en 0C.
  const selfUnknown = classifyRunLiveness(
    { manifest: BOTH, state: stateOf('WAITING_AGENT', 'AUTOMATION', PENDING), pendingResponseJournaled: false },
    evidence({ lock: 'ALIVE_THIS_PROCESS' }),
  );
  assert.equal(selfUnknown.liveness, 'UNDETERMINED');
});

test('(41) ambiguïté déjà matérialisée par CCR → AMBIGUOUS, quelle que soit l’évidence', () => {
  for (const ev of [
    NO_EVIDENCE,
    evidence({ lock: 'ALIVE_OTHER_PROCESS' }),
    evidence({ hostOperation: 'ACTIVE' }),
    evidence({ lock: 'STALE' }),
  ]) {
    const verdict = classifyRunLiveness(
      { manifest: BOTH, state: stateOf('RECOVERY_REQUIRED', 'HUMAN', PENDING), pendingResponseJournaled: false },
      ev,
    );
    assert.equal(verdict.liveness, 'AMBIGUOUS');
    assert.equal(verdict.basis, 'RECOVERY_MATERIALIZED', 'fait canonique : rien ne le contredit');
  }
});

test('un verrou vivant qui ne peut pas être celui de l’opération n’autorise rien', () => {
  // Cas §13 : un `pending_operation` ancien et abandonné traîne, pendant qu'une
  // CLI vient d'acquérir le verrou pour une AUTRE action. Le verrou est bien
  // vivant — mais il ne démontre pas que cette opération-ci est en cours.
  const facts = {
    manifest: BOTH,
    state: stateOf('WAITING_AGENT', 'AUTOMATION', PENDING),
    pendingResponseJournaled: false,
  };

  const external = classifyRunLiveness(
    facts,
    evidence({ lock: 'ALIVE_OTHER_PROCESS', pendingCoveredByLock: 'NO' }),
  );
  assert.equal(external.liveness, 'UNDETERMINED');
  assert.equal(external.basis, 'EVIDENCE_INSUFFICIENT');

  // Même exigence pour une opération de l'hôte lui-même.
  const host = classifyRunLiveness(
    facts,
    evidence({ lock: 'ALIVE_THIS_PROCESS', hostOperation: 'ACTIVE', pendingCoveredByLock: 'NO' }),
  );
  assert.equal(host.liveness, 'UNDETERMINED');

  // Sans information de correspondance, le registre de l'hôte reste probant :
  // il sait qu'il exécute une opération sur ce run.
  const unknown = classifyRunLiveness(
    facts,
    evidence({ lock: 'ALIVE_THIS_PROCESS', hostOperation: 'ACTIVE' }),
  );
  assert.equal(unknown.liveness, 'OPERATION_IN_FLIGHT');
});

test('un hôte étranger n’autorise aucune conclusion', () => {
  const verdict = classifyRunLiveness(
    { manifest: BOTH, state: stateOf('WAITING_AGENT', 'AUTOMATION', PENDING), pendingResponseJournaled: false },
    evidence({ lock: 'FOREIGN_HOST' }),
  );
  assert.equal(verdict.liveness, 'UNDETERMINED');
});

// --------------------------------------------------------------------------
// (42, 43) Ce qui ne décide jamais
// --------------------------------------------------------------------------

test('(42) requiresRecovery seul ne décide jamais du résultat', async () => {
  // Preuve structurelle : le module ne connaît même pas ce prédicat.
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../../src/core/run-liveness.ts', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!code.includes('requiresRecovery'), 'le classificateur n’utilise pas requiresRecovery');

  // Preuve comportementale : à `requiresRecovery` vrai constant, la
  // classification varie selon la seule évidence.
  const facts = { manifest: BOTH, state: stateOf('WAITING_AGENT', 'AUTOMATION', PENDING), pendingResponseJournaled: true };
  const results = new Set([
    classifyRunLiveness(facts, evidence({ hostOperation: 'ACTIVE', pendingCoveredByLock: 'YES' })).liveness,
    classifyRunLiveness(facts, evidence({ lock: 'ABSENT' })).liveness,
    classifyRunLiveness(facts, evidence({ lock: 'STALE' })).liveness,
    classifyRunLiveness(facts, NO_EVIDENCE).liveness,
  ]);
  assert.deepEqual(
    [...results].sort(),
    ['ABANDONED_OPERATION', 'OPERATION_IN_FLIGHT', 'ORPHAN_LOCK', 'UNDETERMINED'],
    'quatre situations distinctes pour un même requiresRecovery',
  );
});

test('(43) l’évidence runtime ne modifie jamais la révision canonique', async () => {
  const { computeRunRevision } = await import('../../src/store/run-snapshot.ts');
  const state = stateOf('WAITING_AGENT', 'AUTOMATION', PENDING);
  const inputs = { manifest: BOTH, state, events: [], decisions: [] };

  // La révision est calculée sur les faits canoniques ; l'évidence n'y entre
  // pas — elle n'est même pas un paramètre.
  const revision = computeRunRevision(inputs);
  for (const ev of [NO_EVIDENCE, evidence({ lock: 'STALE' }), evidence({ hostOperation: 'ACTIVE' })]) {
    classifyRunLiveness({ manifest: BOTH, state, pendingResponseJournaled: false }, ev);
    assert.equal(computeRunRevision(inputs), revision);
  }
});

test('un run au repos avec un verrou vivant reste NONE : une opération courte n’est pas un incident', () => {
  const verdict = classifyRunLiveness(
    { manifest: BOTH, state: stateOf('READY'), pendingResponseJournaled: false },
    evidence({ lock: 'ALIVE_OTHER_PROCESS' }),
  );
  assert.equal(verdict.liveness, 'NONE');
});
