/**
 * Tests unitaires du passage de témoin (lot V1.6).
 *
 * Vérifient la fidélité du transfert, la provenance, la numérotation des
 * rounds et l'absence de rejeu — pas la continuité native, qui relève des
 * tests d'intégration.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { CcrError, isCcrError } from '../../src/core/errors.ts';
import type { CcrErrorCode } from '../../src/core/errors.ts';
import type { RunStateDocument } from '../../src/core/run.ts';
import { openEventStore } from '../../src/store/event-store.ts';
import { roundDir, runPaths } from '../../src/store/layout.ts';
import { readRoundMetadata } from '../../src/store/round-store.ts';
import { persistStateUpdate, readState } from '../../src/store/state-store.ts';
import type { AgentAdapters, RunServiceDeps } from '../../src/services/run-service.ts';
import { findTransferSource, sendMessage, startRun, stepRun } from '../../src/services/run-service.ts';
import {
  CROSS_REVIEW_INSTRUCTION,
  beginMarker,
  buildTransferPrompt,
  counterpartOf,
  endMarker,
  utf8ByteLength,
} from '../../src/services/transfer.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import { TEST_RUNTIME_CONFIG } from '../helpers/runtime-config.ts';
import type { FakeAdapter, FakeAdapterOptions } from '../helpers/fake-adapter.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const WORKSPACE = 'E:/prog/exemple';

interface Harness {
  readonly deps: RunServiceDeps;
  readonly runsDir: string;
  readonly claude: FakeAdapter;
  readonly codex: FakeAdapter;
  cleanup(): Promise<void>;
}

async function harness(
  claudeOptions: Partial<FakeAdapterOptions> = {},
  codexOptions: Partial<FakeAdapterOptions> = {},
  maxTransferBytes?: number,
): Promise<Harness> {
  const runsDir = await makeTempDir('ccr-step-');
  const claude = createFakeAdapter({ kind: 'claude', sessionId: 'claude-uuid-1', ...claudeOptions });
  const codex = createFakeAdapter({ kind: 'codex', sessionId: 'codex-thread-1', ...codexOptions });
  const adapters: AgentAdapters = { claude, codex };

  return {
    runsDir,
    claude,
    codex,
    deps: {
      runsDir,
      now: () => new Date(),
      createAdapters: () => adapters,
      ...(maxTransferBytes === undefined ? {} : { maxTransferBytes }),
    },
    cleanup: () => removeTempDir(runsDir),
  };
}

async function expectCcrError(promise: Promise<unknown>, code: CcrErrorCode): Promise<CcrError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(isCcrError(error), `attendu une CcrError, reçu ${String(error)}`);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`attendu une CcrError ${code}, aucune erreur levée`);
}

async function readPersistedState(runsDir: string, runId: string): Promise<RunStateDocument> {
  return readState(runPaths(runsDir, runId));
}

// --------------------------------------------------------------------------
// Enveloppe de transfert
// --------------------------------------------------------------------------

test('l\'enveloppe encadre le contenu sans le modifier', () => {
  const content = 'Objection : la route n\'est pas appelée.\n\n```py\nx = 1\n```\nAccents éàü, emoji 🙂.';
  const prompt = buildTransferPrompt({
    runId: 'CCR-20260401-001',
    round: 3,
    sourceAgent: 'claude',
    sourceEventId: 'evt_000021',
    content,
  });

  assert.ok(prompt.includes(content), 'le contenu source doit apparaître verbatim');
  assert.ok(prompt.includes('SOURCE: CLAUDE'));
  assert.ok(prompt.includes('RUN: CCR-20260401-001'));
  assert.ok(prompt.includes('ROUND: 3'));
  assert.ok(prompt.includes('SOURCE_EVENT: evt_000021'));
  assert.ok(prompt.includes(`CONTENT_BYTES: ${String(utf8ByteLength(content))}`));
  assert.ok(prompt.includes(beginMarker('evt_000021')));
  assert.ok(prompt.includes(endMarker('evt_000021')));
});

test("des enveloppes imbriquées restent distinguables", () => {
  // Constaté sur un transfert réel : un agent peut recopier l'enveloppe reçue
  // dans sa réponse. Les marqueurs qualifiés par l'événement source évitent
  // que l'enveloppe suivante devienne ambiguë.
  const inner = buildTransferPrompt({
    runId: 'CCR-20260401-001',
    round: 1,
    sourceAgent: 'codex',
    sourceEventId: 'evt_000009',
    content: 'GAMMA-771',
  });
  const outer = buildTransferPrompt({
    runId: 'CCR-20260401-001',
    round: 2,
    sourceAgent: 'claude',
    sourceEventId: 'evt_000012',
    content: inner,
  });

  assert.ok(outer.includes(inner), 'le contenu imbriqué reste verbatim');
  assert.equal(outer.split(endMarker('evt_000012')).length - 1, 1, 'un seul marqueur de fin externe');
  assert.equal(outer.split(endMarker('evt_000009')).length - 1, 1, 'le marqueur interne reste distinct');

  const begin = outer.indexOf(`${beginMarker('evt_000012')}\n`) + `${beginMarker('evt_000012')}\n`.length;
  const end = outer.lastIndexOf(`\n${endMarker('evt_000012')}`);
  assert.equal(outer.slice(begin, end), inner, "le contenu extrait est exactement l'original");
});

test('la consigne transmise est adversariale, pas une demande d\'avis', () => {
  assert.ok(CROSS_REVIEW_INSTRUCTION.includes('réfuter'));
  assert.ok(CROSS_REVIEW_INSTRUCTION.includes("N'invente pas de désaccord"));
  assert.ok(!/qu(e|'| )en penses-tu/i.test(CROSS_REVIEW_INSTRUCTION));
});

test('le destinataire est toujours l\'autre agent', () => {
  assert.equal(counterpartOf('claude'), 'codex');
  assert.equal(counterpartOf('codex'), 'claude');
});

// --------------------------------------------------------------------------
// Sélection de la source
// --------------------------------------------------------------------------

test('la source est la dernière réponse d\'agent, jamais un message humain', () => {
  const base = { run_id: 'CCR-20260401-001', round: 1, timestamp: '2026-08-07T10:00:00.000Z' };
  const source = findTransferSource([
    { ...base, event_id: 'evt_000001', actor: 'claude', type: 'assistant_response', content: 'ancienne' },
    { ...base, event_id: 'evt_000002', actor: 'codex', type: 'assistant_response', content: 'position codex' },
    { ...base, event_id: 'evt_000003', actor: 'human', type: 'human_message', content: 'remarque humaine' },
  ]);

  assert.equal(source.event.event_id, 'evt_000002');
  assert.equal(source.agent, 'codex');
  assert.equal(source.content, 'position codex');
});

test('un journal sans réponse d\'agent produit une erreur explicite', () => {
  assert.throws(
    () =>
      findTransferSource([
        {
          event_id: 'evt_000001',
          run_id: 'CCR-20260401-001',
          round: 0,
          timestamp: '2026-08-07T10:00:00.000Z',
          actor: 'system',
          type: 'run_created',
        },
      ]),
    (error: unknown) => isCcrError(error) && error.code === 'NO_TRANSFERABLE_SOURCE',
  );
});

// --------------------------------------------------------------------------
// Passage de témoin nominal
// --------------------------------------------------------------------------

test('step transfère la dernière réponse Codex vers Claude', async () => {
  const h = await harness();
  try {
    const run = await startRun(h.deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'T', cwd: WORKSPACE, prompt: 'contexte' });
    // Après startRun, la dernière réponse est celle de Codex.
    const result = await stepRun(h.deps, { runId: run.runId });

    assert.equal(result.sourceAgent, 'codex');
    assert.equal(result.targetAgent, 'claude');
    assert.equal(result.targetSessionId, 'claude-uuid-1');
    assert.equal(result.round, 1);
    assert.equal(result.state.state, 'READY');

    const call = h.claude.calls.at(-1);
    assert.equal(call?.phase, 'resume');
    assert.equal(call?.sessionId, 'claude-uuid-1', "l'identifiant natif ne change pas");
    assert.ok(call?.prompt.includes('SOURCE: CODEX'));
  } finally {
    await h.cleanup();
  }
});

test('step suivant renvoie la réponse Claude vers Codex', async () => {
  const h = await harness();
  try {
    const run = await startRun(h.deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'T', cwd: WORKSPACE, prompt: 'contexte' });
    const first = await stepRun(h.deps, { runId: run.runId });
    const second = await stepRun(h.deps, { runId: run.runId });

    assert.equal(first.targetAgent, 'claude');
    assert.equal(second.sourceAgent, 'claude');
    assert.equal(second.targetAgent, 'codex');
    assert.equal(second.targetSessionId, 'codex-thread-1', "l'identifiant natif Codex est inchangé");
    assert.equal(first.round, 1);
    assert.equal(second.round, 2, 'un round par passage de témoin, pas par paire');
  } finally {
    await h.cleanup();
  }
});

test('le contenu source est transmis exactement, sans reformulation', async () => {
  const exact = 'Constat A.\n\n  - point 1\n  - point 2\n\nMAIS attention : "guillemets", \\backslash\\, éàü 🙂\nfin.';
  const h = await harness({}, { respond: () => exact });
  try {
    const run = await startRun(h.deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'T', cwd: WORKSPACE, prompt: 'contexte' });
    await stepRun(h.deps, { runId: run.runId });

    const transferred = h.claude.calls.at(-1)?.prompt ?? '';
    assert.ok(transferred.includes(exact), 'le texte original doit être présent tel quel');

    // Il est encadré par les marqueurs, et rien n'a été retiré entre eux.
    const sourceEventId = /SOURCE_EVENT: (\S+)/.exec(transferred)?.[1] ?? '';
    const opening = `${beginMarker(sourceEventId)}\n`;
    const begin = transferred.indexOf(opening) + opening.length;
    const end = transferred.lastIndexOf(`\n${endMarker(sourceEventId)}`);
    assert.equal(transferred.slice(begin, end), exact);
  } finally {
    await h.cleanup();
  }
});

test('la provenance du transfert est journalisée de bout en bout', async () => {
  const h = await harness();
  try {
    const run = await startRun(h.deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'T', cwd: WORKSPACE, prompt: 'contexte' });
    const result = await stepRun(h.deps, { runId: run.runId });

    const paths = runPaths(h.runsDir, run.runId);
    const events = await (await openEventStore(paths, run.runId)).readAll();
    const started = events.find((event) => event.type === 'round_started');
    const prompt = events.filter((event) => event.type === 'prompt_sent').at(-1);
    const response = events.filter((event) => event.type === 'assistant_response').at(-1);
    const completed = events.find((event) => event.type === 'round_completed');

    assert.equal(started?.round, 1);
    assert.equal(started?.details?.['source_event_id'], result.sourceEventId);
    assert.equal(started?.details?.['target_agent'], 'claude');

    assert.equal(prompt?.actor, 'system', 'le transfert est émis par CCR, pas par un agent');
    assert.deepEqual(prompt?.based_on, [result.sourceEventId]);
    assert.equal(prompt?.target, 'claude');

    assert.equal(response?.actor, 'claude');
    assert.deepEqual(completed?.based_on, [result.sourceEventId, response?.event_id]);
  } finally {
    await h.cleanup();
  }
});

test('la projection de round référence les événements réellement écrits', async () => {
  // Régression : `prompt_event_id` recevait l'identifiant de `round_started`
  // au lieu de celui du `prompt_sent`. Le journal restait correct, mais la
  // projection `rounds/` portait une provenance factuellement fausse.
  const h = await harness();
  try {
    const run = await startRun(h.deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'T', cwd: WORKSPACE, prompt: 'contexte' });
    const result = await stepRun(h.deps, { runId: run.runId });

    const paths = runPaths(h.runsDir, run.runId);
    const events = await (await openEventStore(paths, run.runId)).readAll();
    const byId = new Map(events.map((event) => [event.event_id, event]));

    const metadata = await readRoundMetadata(paths, result.round);
    const turn = metadata.turns[0];
    assert.ok(turn !== undefined);

    // --- prompt_event_id ---
    const promptEvent = byId.get(turn.prompt_event_id);
    assert.ok(promptEvent !== undefined, 'le prompt référencé doit exister dans le journal');
    assert.equal(promptEvent.type, 'prompt_sent', 'et être de type prompt_sent');
    assert.equal(promptEvent.round, result.round);
    assert.equal(promptEvent.target, result.targetAgent);
    assert.deepEqual(promptEvent.based_on, [result.sourceEventId]);

    // Le prompt référencé est bien celui réellement transmis pour ce round.
    const sentPrompt = await readFile(
      path.join(roundDir(paths, result.round), `${result.targetAgent}_prompt.txt`),
      'utf8',
    );
    assert.equal(promptEvent.content, sentPrompt);
    assert.equal(promptEvent.content, h.claude.calls.at(-1)?.prompt);

    // Régression explicite : ce n'est pas l'événement round_started.
    const roundStarted = events.find(
      (event) => event.type === 'round_started' && event.round === result.round,
    );
    assert.ok(roundStarted !== undefined);
    assert.notEqual(turn.prompt_event_id, roundStarted.event_id);

    // --- response_event_id ---
    const responseEvent = turn.response_event_id === null ? undefined : byId.get(turn.response_event_id);
    assert.ok(responseEvent !== undefined, 'la réponse référencée doit exister');
    assert.equal(responseEvent.type, 'assistant_response', 'et être de type assistant_response');
    assert.equal(responseEvent.actor, result.targetAgent);
    assert.deepEqual(responseEvent.based_on, [turn.prompt_event_id]);
    assert.equal(responseEvent.content, result.response);

    // --- source_event_id porté par les événements de round ---
    const sourceEvent = byId.get(result.sourceEventId);
    assert.equal(sourceEvent?.type, 'assistant_response');
    for (const type of ['round_started', 'round_completed'] as const) {
      const event = events.find((candidate) => candidate.type === type && candidate.round === result.round);
      assert.equal(event?.details?.['source_event_id'], result.sourceEventId, `${type}.source_event_id`);
    }
  } finally {
    await h.cleanup();
  }
});

test('chaque round successif référence son propre prompt_sent', async () => {
  const h = await harness();
  try {
    const run = await startRun(h.deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'T', cwd: WORKSPACE, prompt: 'contexte' });
    const first = await stepRun(h.deps, { runId: run.runId });
    const second = await stepRun(h.deps, { runId: run.runId });

    const paths = runPaths(h.runsDir, run.runId);
    const events = await (await openEventStore(paths, run.runId)).readAll();
    const byId = new Map(events.map((event) => [event.event_id, event]));

    const ids: string[] = [];
    for (const round of [first.round, second.round]) {
      const turn = (await readRoundMetadata(paths, round)).turns[0];
      assert.ok(turn !== undefined);
      assert.equal(byId.get(turn.prompt_event_id)?.type, 'prompt_sent');
      assert.equal(byId.get(turn.prompt_event_id)?.round, round);
      ids.push(turn.prompt_event_id);
    }

    assert.equal(new Set(ids).size, 2, 'deux rounds ne partagent pas le même prompt');
  } finally {
    await h.cleanup();
  }
});

test('un round produit ses artefacts sur disque', async () => {
  const h = await harness();
  try {
    const run = await startRun(h.deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'T', cwd: WORKSPACE, prompt: 'contexte' });
    await stepRun(h.deps, { runId: run.runId });

    const paths = runPaths(h.runsDir, run.runId);
    const dir = roundDir(paths, 1);
    const prompt = await readFile(path.join(dir, 'claude_prompt.txt'), 'utf8');
    const response = await readFile(path.join(dir, 'claude_response.txt'), 'utf8');

    assert.ok(prompt.includes('SOURCE: CODEX'));
    assert.ok(response.startsWith('claude:'));

    const metadata = await readRoundMetadata(paths, 1);
    assert.equal(metadata.round, 1);
    assert.equal(metadata.workspace_cwd, WORKSPACE);
    assert.equal(metadata.turns[0]?.agent, 'claude');
  } finally {
    await h.cleanup();
  }
});

// --------------------------------------------------------------------------
// Absence de rejeu
// --------------------------------------------------------------------------

test('une source déjà consommée par un round abouti est refusée', () => {
  // Garde d'invariant : si la dernière réponse d'agent porte déjà un
  // `round_completed` la désignant comme source, la retransférer rejouerait le
  // même tour. La relation est explicite dans le journal.
  const base = { run_id: 'CCR-20260401-001', round: 1, timestamp: '2026-08-07T10:00:00.000Z' };

  assert.throws(
    () =>
      findTransferSource([
        { ...base, event_id: 'evt_000001', actor: 'codex', type: 'assistant_response', content: 'position' },
        {
          ...base,
          event_id: 'evt_000002',
          actor: 'system',
          type: 'round_completed',
          based_on: ['evt_000001'],
          details: { source_event_id: 'evt_000001', target_agent: 'claude' },
        },
      ]),
    (error: unknown) => {
      assert.ok(isCcrError(error));
      assert.equal(error.code, 'SOURCE_ALREADY_TRANSFERRED');
      assert.equal(error.details['sourceEventId'], 'evt_000001');
      return true;
    },
  );
});

test('la réponse produite par un round n\'est pas confondue avec la source qu\'il a consommée', () => {
  // `based_on` d'un `round_completed` porte la source ET la réponse. Seule
  // `details.source_event_id` désigne la source ; confondre les deux bloquerait
  // le passage de témoin suivant.
  const base = { run_id: 'CCR-20260401-001', round: 1, timestamp: '2026-08-07T10:00:00.000Z' };
  const source = findTransferSource([
    { ...base, event_id: 'evt_000001', actor: 'codex', type: 'assistant_response', content: 'position codex' },
    { ...base, event_id: 'evt_000002', actor: 'claude', type: 'assistant_response', content: 'réfutation claude' },
    {
      ...base,
      event_id: 'evt_000003',
      actor: 'system',
      type: 'round_completed',
      based_on: ['evt_000001', 'evt_000002'],
      details: { source_event_id: 'evt_000001', target_agent: 'claude' },
    },
  ]);

  assert.equal(source.event.event_id, 'evt_000002');
  assert.equal(source.agent, 'claude');
});

test('des passages de témoin successifs consomment chacun une source nouvelle', async () => {
  const h = await harness();
  try {
    const run = await startRun(h.deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'T', cwd: WORKSPACE, prompt: 'contexte' });

    const first = await stepRun(h.deps, { runId: run.runId });
    const second = await stepRun(h.deps, { runId: run.runId });
    const third = await stepRun(h.deps, { runId: run.runId });

    // Aucune source n'est réutilisée : chaque round consomme la réponse
    // produite par le round précédent.
    const sources = [first.sourceEventId, second.sourceEventId, third.sourceEventId];
    assert.equal(new Set(sources).size, 3, 'aucun rejeu de source');
    assert.deepEqual(
      [first.round, second.round, third.round],
      [1, 2, 3],
      'un seul incrément de round par passage de témoin',
    );
    assert.deepEqual(
      [first.targetAgent, second.targetAgent, third.targetAgent],
      ['claude', 'codex', 'claude'],
      'le témoin alterne strictement',
    );
  } finally {
    await h.cleanup();
  }
});

test("la réponse d'un agent à un message humain devient la source suivante", async () => {
  const h = await harness();
  try {
    const run = await startRun(h.deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'T', cwd: WORKSPACE, prompt: 'contexte' });
    await stepRun(h.deps, { runId: run.runId });

    // L'humain relance Claude ; c'est sa réponse — non son message — qui sert
    // de source au passage de témoin suivant.
    await sendMessage(h.deps, { runId: run.runId, agent: 'claude', message: 'précision humaine' });
    const result = await stepRun(h.deps, { runId: run.runId });

    const events = await (await openEventStore(runPaths(h.runsDir, run.runId), run.runId)).readAll();
    const sourceEvent = events.find((event) => event.event_id === result.sourceEventId);

    assert.equal(sourceEvent?.type, 'assistant_response');
    assert.equal(sourceEvent?.actor, 'claude');
    assert.equal(sourceEvent?.content, 'claude:précision humaine');
    assert.equal(result.targetAgent, 'codex');
    assert.equal(result.round, 2);
  } finally {
    await h.cleanup();
  }
});

// --------------------------------------------------------------------------
// Garde-fou de taille (§27)
// --------------------------------------------------------------------------

test('un transfert trop volumineux est refusé sans aucun appel agent', async () => {
  const enorme = 'é'.repeat(5_000); // 10 000 octets UTF-8
  const h = await harness({}, { respond: () => enorme }, 4_096);
  try {
    const run = await startRun(h.deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'T', cwd: WORKSPACE, prompt: 'contexte' });
    const callsBefore = h.claude.calls.length;

    const error = await expectCcrError(
      stepRun(h.deps, { runId: run.runId }),
      'PAYLOAD_TOO_LARGE_FOR_AUTOMATIC_TRANSFER',
    );

    assert.equal(h.claude.calls.length, callsBefore, 'aucun appel agent ne doit avoir lieu');
    assert.equal(error.details['limit'], 4_096);
    assert.ok(Number(error.details['bytes']) > 10_000);

    const state = await readPersistedState(h.runsDir, run.runId);
    assert.equal(state.state, 'WAITING_HUMAN');
    assert.equal(state.control, 'HUMAN');
    assert.equal(state.round, 0, "aucun round n'a démarré");

    // Le contenu source reste intact : ni tronqué, ni résumé.
    const events = await (await openEventStore(runPaths(h.runsDir, run.runId), run.runId)).readAll();
    const source = events.filter((event) => event.type === 'assistant_response').at(-1);
    assert.equal(source?.content, enorme);

    const guard = events.at(-1);
    assert.equal(guard?.type, 'state_changed');
    assert.equal(guard?.details?.['reason'], 'PAYLOAD_TOO_LARGE_FOR_AUTOMATIC_TRANSFER');
    assert.equal(guard?.details?.['to'], 'WAITING_HUMAN');
  } finally {
    await h.cleanup();
  }
});

test('le seuil se mesure en octets UTF-8 et non en caractères', () => {
  assert.equal(utf8ByteLength('abc'), 3);
  assert.equal(utf8ByteLength('éàü'), 6);
  assert.equal(utf8ByteLength('🙂'), 4);
});

// --------------------------------------------------------------------------
// Échecs et contrôle
// --------------------------------------------------------------------------

test("un échec de l'agent cible ne consomme pas la source et laisse le run reprenable", async () => {
  let shouldFail = true;
  const h = await harness({
    failResume: () => (shouldFail ? new CcrError('AGENT_EXIT_NONZERO', 'claude indisponible') : undefined),
  });
  try {
    const run = await startRun(h.deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'T', cwd: WORKSPACE, prompt: 'contexte' });

    await expectCcrError(stepRun(h.deps, { runId: run.runId }), 'AGENT_EXIT_NONZERO');

    const afterFailure = await readPersistedState(h.runsDir, run.runId);
    assert.equal(afterFailure.state, 'PAUSED', 'incident opérationnel, pas invariant brisé');
    assert.equal(afterFailure.control, 'HUMAN');
    assert.equal(afterFailure.active_agent, null);

    // La source n'a pas été consommée : le passage de témoin reste rejouable.
    shouldFail = false;
    await persistStateUpdate(runPaths(h.runsDir, run.runId), afterFailure, {
      state: 'READY',
      control: 'AUTOMATION',
    });

    const retry = await stepRun(h.deps, { runId: run.runId });
    assert.equal(retry.sourceAgent, 'codex');
    assert.equal(retry.targetAgent, 'claude');
  } finally {
    await h.cleanup();
  }
});

test("step refuse d'agir lorsque le contrôle appartient à l'humain", async () => {
  const h = await harness();
  try {
    const run = await startRun(h.deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'T', cwd: WORKSPACE, prompt: 'contexte' });
    const paths = runPaths(h.runsDir, run.runId);
    await persistStateUpdate(paths, await readState(paths), { state: 'PAUSED', control: 'HUMAN' });

    const callsBefore = h.claude.calls.length;
    const error = await expectCcrError(stepRun(h.deps, { runId: run.runId }), 'AUTOMATION_NOT_IN_CONTROL');

    assert.equal(error.details['control'], 'HUMAN');
    assert.equal(h.claude.calls.length, callsBefore);
  } finally {
    await h.cleanup();
  }
});

test("sans aucune réponse d'agent, step échoue explicitement plutôt que d'inventer un prompt", async () => {
  const h = await harness({ failStart: () => new CcrError('AGENT_EXIT_NONZERO', 'claude indisponible') });
  try {
    const run = await startRun(h.deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'T', cwd: WORKSPACE, prompt: 'contexte' });
    const paths = runPaths(h.runsDir, run.runId);
    await persistStateUpdate(paths, await readState(paths), { state: 'READY', control: 'AUTOMATION' });

    await expectCcrError(stepRun(h.deps, { runId: run.runId }), 'NO_TRANSFERABLE_SOURCE');
  } finally {
    await h.cleanup();
  }
});

test('step refuse un run dont la session cible est absente', async () => {
  // Claude créé, Codex non : la source est la réponse Claude, la cible manque.
  const h = await harness({}, { failStart: () => new CcrError('AGENT_EXIT_NONZERO', 'codex indisponible') });
  try {
    const run = await startRun(h.deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'T', cwd: WORKSPACE, prompt: 'contexte' });
    const paths = runPaths(h.runsDir, run.runId);
    await persistStateUpdate(paths, await readState(paths), { state: 'READY', control: 'AUTOMATION' });

    const callsBefore = h.codex.calls.length;
    const error = await expectCcrError(stepRun(h.deps, { runId: run.runId }), 'SESSION_MISSING');

    assert.equal(error.details['agent'], 'codex');
    assert.equal(h.codex.calls.length, callsBefore);
  } finally {
    await h.cleanup();
  }
});

test('step ne déclenche jamais plus d\'un passage de témoin', async () => {
  const h = await harness();
  try {
    const run = await startRun(h.deps, { runtimeConfig: TEST_RUNTIME_CONFIG, title: 'T', cwd: WORKSPACE, prompt: 'contexte' });
    const claudeBefore = h.claude.calls.length;
    const codexBefore = h.codex.calls.length;

    await stepRun(h.deps, { runId: run.runId });

    assert.equal(h.claude.calls.length, claudeBefore + 1, 'exactement un appel vers la cible');
    assert.equal(h.codex.calls.length, codexBefore, 'aucun enchaînement automatique');
  } finally {
    await h.cleanup();
  }
});
