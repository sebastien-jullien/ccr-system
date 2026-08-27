/**
 * Slice 2E-R — Native Recovery CLI.
 *
 * Le moteur historique n'a qu'une reprise ; le natif en a quatre, aux gestes et
 * aux conséquences différentes, et plusieurs diagnostics peuvent coexister sur
 * le même run. La CLI n'en choisit donc **jamais** un : toute mutation nomme
 * son domaine et son geste, et c'est la primitive appelée qui décide, sous
 * verrou, si ce geste est encore possible.
 *
 * Aucun fournisseur réel, aucun terminal. Un seul geste peut engager un
 * fournisseur — `initialization / continue` — et il est prouvé avec des
 * adapters factices, comptés.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { runCli } from '../../src/cli/main.ts';
import type { CliIo } from '../../src/cli/main.ts';
import { CcrError } from '../../src/core/errors.ts';
import type { AgentRuntimeProbe } from '../../src/runtime/agent-runtime-probe.ts';
import type { StartPreflightDeps } from '../../src/runtime/preflight-service.ts';
import type { AgentAdapters, RunServiceDeps } from '../../src/services/run-service.ts';
import { startRun } from '../../src/services/run-service.ts';
import { startNativeRun } from '../../src/services/native-start-service.ts';
import { sendNativeMessage } from '../../src/services/native-send-service.ts';
import { handoffNativeExpert } from '../../src/services/native-handoff-service.ts';
import { stepNativeRun } from '../../src/services/native-step-service.ts';
import { expertSlotTarget } from '../../src/services/native-target-resolver.ts';
import { buildNativeRunReadModel } from '../../src/services/native-read-model.ts';
import { NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION } from '../../src/core/run-native.ts';
import type { NativeCcrEvent, NativeRunRuntimeConfig } from '../../src/core/run-native.ts';
import type { RunState } from '../../src/core/state.ts';
import { runPaths } from '../../src/store/layout.ts';
import { openNativeEventStore } from '../../src/store/native-event-store.ts';
import {
  persistNativeStateUpdate,
  readPersistedManifest,
  readPersistedState,
} from '../../src/store/native-store.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import type { FakeAdapter } from '../helpers/fake-adapter.ts';
import { TEST_RUNTIME_CONFIG } from '../helpers/runtime-config.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const MISSION = 'Mission initiale : évaluer la refonte.';
/**
 * Témoin d'acquittement — **avec bordures** (repair IMP-15.1).
 *
 * Les deux espaces de tête et de queue ne sont pas décoratifs : sans eux, un
 * moteur qui rognerait la note satisferait quand même l'égalité, et c'est
 * exactement ainsi que la propriété a pu être déclarée tenue alors qu'elle ne
 * l'était pas.
 */
const NOTE = '  « décision humaine — élève / β »  ';

interface Capture extends CliIo {
  text(): string;
  errorText(): string;
}

function capture(): Capture {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    out: (text) => stdout.push(text),
    err: (text) => stderr.push(text),
    text: () => stdout.join('\n'),
    errorText: () => stderr.join('\n'),
  };
}

interface Harness {
  readonly runsDir: string;
  readonly deps: RunServiceDeps;
  readonly preflight: StartPreflightDeps;
  /** Appels model-producing simulés : `start` et `resume` des fixtures. */
  modelCalls(): readonly string[];
  interactives(): readonly string[];
  cleanup(): Promise<void>;
}

function fakePreflight(runsDir: string): StartPreflightDeps {
  const probe = (agent: 'claude' | 'codex'): AgentRuntimeProbe => ({
    agent,
    installed: true,
    version: '1.0.0',
    authStatus: 'AUTHENTICATED',
    launcherSource: 'path',
  });
  return {
    configPath: path.join(runsDir, 'config-isole.json'),
    env: {},
    tty: { stdin: false, stdout: false },
    probes: { claude: async () => probe('claude'), codex: async () => probe('codex') },
  };
}

async function harness(
  options: { readonly failStart?: Partial<Record<'claude' | 'codex', () => unknown>> } = {},
): Promise<Harness> {
  const runsDir = await makeTempDir('ccr-2er-');
  const modelCalls: string[] = [];
  const interactives: string[] = [];
  const build = (kind: 'claude' | 'codex'): FakeAdapter =>
    createFakeAdapter({
      kind,
      startSessionIds: [`${kind}-1`, `${kind}-2`],
      sessionId: `${kind}-1`,
      ...(options.failStart?.[kind] === undefined ? {} : { failStart: options.failStart[kind] }),
      onCall: (phase) => {
        modelCalls.push(`${kind}:${phase}`);
      },
      onInteractive: (sessionId) => {
        interactives.push(`${kind}:${sessionId}`);
      },
    });
  const adapters = { claude: build('claude'), codex: build('codex') };
  return {
    runsDir,
    modelCalls: () => modelCalls,
    interactives: () => interactives,
    deps: { runsDir, now: () => new Date(), createAdapters: (): AgentAdapters => adapters },
    preflight: fakePreflight(runsDir),
    cleanup: () => removeTempDir(runsDir),
  };
}

function nativeRuntime(): NativeRunRuntimeConfig {
  return {
    schema_version: NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION,
    captured_at: new Date(0).toISOString(),
    claude: { required: true, probe_status: 'OBSERVED', cli_version: '1', auth_preflight: 'AUTHENTICATED' },
    codex: {
      required: true,
      probe_status: 'OBSERVED',
      cli_version: '1',
      auth_preflight: 'AUTHENTICATED',
      skip_git_repo_check: false,
      source_at_capture: 'default',
    },
  };
}

async function nativeRun(h: Harness): Promise<string> {
  const started = await startNativeRun(h.deps, {
    title: 'T',
    cwd: h.runsDir,
    prompt: MISSION,
    runtimeConfig: nativeRuntime(),
  });
  return started.runId;
}

async function forceState(
  h: Harness,
  runId: string,
  update: { state: RunState; control?: 'AUTOMATION' | 'HUMAN' },
): Promise<void> {
  const paths = runPaths(h.runsDir, runId);
  const current = await readPersistedState(paths);
  if (current.execution_mode !== 'NATIVE_V21_EXECUTION') throw new Error('état natif attendu');
  await persistNativeStateUpdate(
    paths,
    current.document,
    { state: update.state, ...(update.control === undefined ? {} : { control: update.control }) },
    new Date(),
  );
}

async function journal(h: Harness, runId: string): Promise<readonly NativeCcrEvent[]> {
  const paths = runPaths(h.runsDir, runId);
  const persisted = await readPersistedManifest(paths);
  if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') throw new Error('run natif attendu');
  return (await openNativeEventStore(paths, persisted.manifest)).readAll();
}

interface Snapshot {
  readonly state: string;
  readonly events: string;
}

async function snapshot(h: Harness, runId: string): Promise<Snapshot> {
  const paths = runPaths(h.runsDir, runId);
  return { state: await readFile(paths.state, 'utf8'), events: await readFile(paths.events, 'utf8') };
}

/** Fenêtre de crash, capturée puis restaurée : ce qu'un arrêt brutal aurait laissé. */
async function restore(h: Harness, runId: string, captured: Snapshot): Promise<void> {
  const paths = runPaths(h.runsDir, runId);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(paths.state, captured.state, 'utf8');
  await writeFile(paths.events, captured.events, 'utf8');
}

// ==========================================================================
// A. Aiguillage et refus purs
// ==========================================================================

test('1–6 · une reprise se nomme entièrement, et ne traverse jamais la mauvaise génération', async () => {
  const h = await harness();
  try {
    // 1 · run historique : la reprise historique, inchangée.
    const legacy = await startRun(h.deps, {
      runtimeConfig: TEST_RUNTIME_CONFIG,
      title: 'historique',
      cwd: 'E:/prog/exemple',
      prompt: 'p',
    });
    const legacyIo = capture();
    assert.equal(
      await runCli(['recover', '--run', legacy.runId], { deps: h.deps, io: legacyIo }),
      0,
      legacyIo.errorText(),
    );

    // 6 · options natives sur un run historique : usage, run intact.
    const legacyPaths = runPaths(h.runsDir, legacy.runId);
    const legacyBefore = await readFile(legacyPaths.state, 'utf8');
    const mixedIo = capture();
    assert.equal(
      await runCli(['recover', '--run', legacy.runId, '--domain', 'send', '--action', 'finalize'], {
        deps: h.deps,
        io: mixedIo,
      }),
      2,
    );
    assert.ok(mixedIo.errorText().includes('--domain'));
    assert.equal(await readFile(legacyPaths.state, 'utf8'), legacyBefore);

    // 2 · run natif sans geste : lecture seule, inventaire, aucune mutation.
    const runId = await nativeRun(h);
    const before = await snapshot(h, runId);
    const bare = capture();
    assert.equal(await runCli(['recover', '--run', runId], { deps: h.deps, io: bare }), 2);
    assert.ok(bare.text().includes('initialization'));
    assert.ok(bare.text().includes('step'));
    assert.ok(bare.text().includes('send'));
    assert.ok(bare.text().includes('handoff'));
    assert.ok(bare.errorText().includes('Aucun geste'));
    assert.deepEqual(await snapshot(h, runId), before, 'aucune mutation');

    // 3–5 · moitiés d'invocation et couples inexistants : usage, rien écrit.
    const refusals: readonly (readonly [string, readonly string[]])[] = [
      ['domaine seul', ['--domain', 'send']],
      ['geste seul', ['--action', 'finalize']],
      ['domaine inconnu', ['--domain', 'transfert', '--action', 'finalize']],
      ['geste inconnu', ['--domain', 'send', '--action', 'retry']],
      ['couple impossible', ['--domain', 'send', '--action', 'abort-before-interactive']],
      ['couple impossible', ['--domain', 'handoff', '--action', 'abort-before-provider']],
      ['couple impossible', ['--domain', 'step', '--action', 'continue']],
    ];
    for (const [label, flags] of refusals) {
      const io = capture();
      assert.equal(await runCli(['recover', '--run', runId, ...flags], { deps: h.deps, io }), 2, label);
      assert.deepEqual(await snapshot(h, runId), before, `${label} : aucune mutation`);
    }
    assert.equal(h.interactives().length, 0);
  } finally {
    await h.cleanup();
  }
});

// ==========================================================================
// B. Initialisation — le seul geste pouvant engager un fournisseur
// ==========================================================================

test('7–9 · `initialization / continue` ne reprend que le slot réellement manquant', async () => {
  const h = await harness({
    failStart: { claude: () => new CcrError('AGENT_TIMEOUT', 'le challenger a échoué') },
  });
  try {
    // START partiel : l'author (codex) aboutit, le challenger (claude) échoue.
    const started = await startNativeRun(h.deps, {
      title: 'T',
      cwd: h.runsDir,
      prompt: MISSION,
      runtimeConfig: nativeRuntime(),
    });
    assert.equal(started.failure?.slot, 'challenger');
    const callsAfterStart = h.modelCalls().length;

    // Le challenger cesse d'échouer : la reprise peut aboutir.
    const healed = await harness();
    const deps: RunServiceDeps = { ...healed.deps, runsDir: h.runsDir };

    const io = capture();
    assert.equal(
      await runCli(
        ['recover', '--run', started.runId, '--domain', 'initialization', '--action', 'continue'],
        { deps, io },
      ),
      0,
      io.errorText(),
    );

    // 7 · exactement un appel simulé, et c'est celui du slot manquant.
    assert.deepEqual(healed.modelCalls(), ['claude:start'], 'un seul slot repris');
    assert.equal(h.modelCalls().length, callsAfterStart, 'le slot complet n’est pas rejoué');

    const manifest = await readPersistedManifest(runPaths(h.runsDir, started.runId));
    if (manifest.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('run natif attendu');
    assert.equal(manifest.manifest.experts.author.session_id, 'codex-1');
    assert.equal(manifest.manifest.experts.challenger.session_id, 'claude-1');
    assert.ok(io.text().includes('RECOVERY initialization : NONE'));
    assert.ok(io.text().includes('control : HUMAN'));

    // 9 · le même geste, désormais sans objet, est refusé par le backend.
    const again = capture();
    assert.equal(
      await runCli(
        ['recover', '--run', started.runId, '--domain', 'initialization', '--action', 'acknowledge-uncertainty', '--note', NOTE],
        { deps, io: again },
      ),
      1,
      'refus dynamique du moteur, pas de la CLI',
    );
    assert.ok(again.errorText().includes('INVALID_ARGUMENT'));

    await healed.cleanup();
  } finally {
    await h.cleanup();
  }
});

// ==========================================================================
// C. Transfert
// ==========================================================================

test('10–12 · la reprise de transfert n’appelle aucun fournisseur, et sa quarantaine tient', async () => {
  const h = await harness();
  try {
    const runId = await nativeRun(h);

    // Fenêtre : contexte engagé, aucune réponse — capturée pendant l'appel.
    const paths = runPaths(h.runsDir, runId);
    let inFlight: Snapshot | undefined;
    const adapters = h.deps.createAdapters('', {} as never);
    const target = adapters.claude;
    const original = target.resume.bind(target);
    (target as { resume: typeof target.resume }).resume = async (session, prompt) => {
      inFlight = { state: await readFile(paths.state, 'utf8'), events: await readFile(paths.events, 'utf8') };
      return original(session, prompt);
    };
    await stepNativeRun(h.deps, runId);
    (target as { resume: typeof target.resume }).resume = original;
    assert.ok(inFlight !== undefined);
    await restore(h, runId, inFlight);

    const callsBefore = h.modelCalls().length;
    const io = capture();
    assert.equal(
      await runCli(
        ['recover', '--run', runId, '--domain', 'step', '--action', 'acknowledge-uncertainty', '--note', NOTE],
        { deps: h.deps, io },
      ),
      0,
      io.errorText(),
    );

    // 10–11 · aucun appel, et le marqueur est celui du backend.
    assert.equal(h.modelCalls().length, callsBefore, 'aucun rejeu fournisseur');
    // Le rendu post-geste ne propose plus de finalisation fantôme : depuis le
    // repair 1G.2, un acquittement commité ferme la reprise.
    assert.ok(io.text().includes('RECOVERY step : NONE'));
    const markers = (await journal(h, runId)).filter(
      (event) => event.type === 'transfer_uncertainty_acknowledged',
    );
    assert.equal(markers.length, 1);
    assert.equal((markers[0] as unknown as Record<string, unknown>)['content'], NOTE, 'note transmise');

    // 12 · la source reste inrejouable tant qu'aucune réponse neuve n'existe.
    await forceState(h, runId, { state: 'READY', control: 'AUTOMATION' });
    const replayable = await buildNativeRunReadModel({ runsDir: h.runsDir }, runId);
    assert.equal(replayable.operations.step.allowed, false);
    assert.equal(replayable.operations.step.reason_code, 'SOURCE_NOT_REPLAYABLE');
    // Les trois autres domaines restent silencieux : rien n'a été purgé.
    assert.equal(replayable.recovery.send.status, 'NONE');
    assert.equal(replayable.recovery.handoff.status, 'NONE');
  } finally {
    await h.cleanup();
  }
});

// ==========================================================================
// D. Envoi
// ==========================================================================

test('13–15 · les trois gestes d’envoi écrivent exactement le fait du backend', async () => {
  // 13 · clôture avant appel.
  const aborted = await harness();
  try {
    const runId = await nativeRun(aborted);
    let s0: Snapshot | undefined;
    await sendNativeMessage(aborted.deps, runId, expertSlotTarget('author'), 'question', {
      afterHumanMessageJournaled: async () => {
        s0 = await snapshot(aborted, runId);
      },
    });
    assert.ok(s0 !== undefined);
    await restore(aborted, runId, s0);

    const calls = aborted.modelCalls().length;
    const io = capture();
    assert.equal(
      await runCli(
        ['recover', '--run', runId, '--domain', 'send', '--action', 'abort-before-provider'],
        { deps: aborted.deps, io },
      ),
      0,
      io.errorText(),
    );
    assert.equal(aborted.modelCalls().length, calls, 'aucun fournisseur');
    const markers = (await journal(aborted, runId)).filter(
      (event) => event.type === 'send_aborted_before_provider',
    );
    assert.equal(markers.length, 1);
    assert.ok(io.text().includes('RECOVERY send : NONE'));
  } finally {
    await aborted.cleanup();
  }

  // 14–15 · incertitude acquittée, puis finalisation d'une réponse durable.
  const uncertain = await harness();
  try {
    const runId = await nativeRun(uncertain);
    const paths = runPaths(uncertain.runsDir, runId);
    let inFlight: Snapshot | undefined;
    let responded: Snapshot | undefined;
    const adapters = uncertain.deps.createAdapters('', {} as never);
    const target = adapters.codex;
    const original = target.resume.bind(target);
    (target as { resume: typeof target.resume }).resume = async (session, prompt) => {
      inFlight = { state: await readFile(paths.state, 'utf8'), events: await readFile(paths.events, 'utf8') };
      return original(session, prompt);
    };
    await sendNativeMessage(uncertain.deps, runId, expertSlotTarget('author'), 'question', {
      afterResponseJournaled: async () => {
        responded = await snapshot(uncertain, runId);
      },
    });
    (target as { resume: typeof target.resume }).resume = original;
    assert.ok(inFlight !== undefined && responded !== undefined);

    await restore(uncertain, runId, inFlight);
    const ackIo = capture();
    assert.equal(
      await runCli(
        ['recover', '--run', runId, '--domain', 'send', '--action', 'acknowledge-uncertainty', '--note', NOTE],
        { deps: uncertain.deps, io: ackIo },
      ),
      0,
      ackIo.errorText(),
    );
    const acks = (await journal(uncertain, runId)).filter(
      (event) => event.type === 'send_uncertainty_acknowledged',
    );
    assert.equal(acks.length, 1);
    // La CLI transmet la note originale, et le moteur la persiste telle quelle.
    const persistedNote = (acks[0] as unknown as Record<string, unknown>)['content'];
    assert.equal(persistedNote, NOTE, 'note persistée bit pour bit');
    assert.notEqual(persistedNote, NOTE.trim(), 'le témoin distingue les deux comportements');

    // 15 · finalisation d'une réponse durable : aucune seconde réponse.
    await restore(uncertain, runId, responded);
    const before = (await snapshot(uncertain, runId)).events;
    const calls = uncertain.modelCalls().length;
    const finalizeIo = capture();
    assert.equal(
      await runCli(['recover', '--run', runId, '--domain', 'send', '--action', 'finalize'], {
        deps: uncertain.deps,
        io: finalizeIo,
      }),
      0,
      finalizeIo.errorText(),
    );
    assert.equal((await snapshot(uncertain, runId)).events, before, 'journal inchangé');
    assert.equal(uncertain.modelCalls().length, calls, 'aucun rejeu');
  } finally {
    await uncertain.cleanup();
  }
});

// ==========================================================================
// E. Handoff
// ==========================================================================

test('16–18 · les gestes de handoff ne réouvrent jamais de terminal', async () => {
  const h = await harness();
  try {
    const runId = await nativeRun(h);
    await forceState(h, runId, { state: 'PAUSED', control: 'HUMAN' });

    let h0: Snapshot | undefined;
    let h1: Snapshot | undefined;
    let h2: Snapshot | undefined;
    await handoffNativeExpert(h.deps, runId, expertSlotTarget('author'), {
      afterStartedJournaled: async () => {
        h0 = await snapshot(h, runId);
      },
      afterPendingPersisted: async () => {
        h1 = await snapshot(h, runId);
      },
      afterFinishedJournaled: async () => {
        h2 = await snapshot(h, runId);
      },
    });
    assert.ok(h0 !== undefined && h1 !== undefined && h2 !== undefined);
    const interactivesAfterHandoff = h.interactives().length;

    // 16 · clôture avant lancement.
    await restore(h, runId, h0);
    const abortIo = capture();
    assert.equal(
      await runCli(
        ['recover', '--run', runId, '--domain', 'handoff', '--action', 'abort-before-interactive'],
        { deps: h.deps, io: abortIo },
      ),
      0,
      abortIo.errorText(),
    );
    assert.equal(
      (await journal(h, runId)).filter((event) => event.type === 'handoff_aborted_before_interactive')
        .length,
      1,
    );

    // 17 · incertitude acquittée : aucune réouverture, et la barrière du
    // planificateur est celle du backend.
    await restore(h, runId, h1);
    const ackIo = capture();
    assert.equal(
      await runCli(
        ['recover', '--run', runId, '--domain', 'handoff', '--action', 'acknowledge-uncertainty', '--note', NOTE],
        { deps: h.deps, io: ackIo },
      ),
      0,
      ackIo.errorText(),
    );
    assert.equal(h.interactives().length, interactivesAfterHandoff, 'aucun terminal réouvert');
    assert.equal(
      (await journal(h, runId)).filter((event) => event.type === 'handoff_uncertainty_acknowledged')
        .length,
      1,
    );
    await forceState(h, runId, { state: 'READY', control: 'AUTOMATION' });
    const barrier = await buildNativeRunReadModel({ runsDir: h.runsDir }, runId);
    assert.equal(barrier.operations.step.reason_code, 'SOURCE_STALE_AFTER_HANDOFF');

    // 18 · finalisation d'une interaction terminée : aucune seconde fin.
    await restore(h, runId, h2);
    const before = (await snapshot(h, runId)).events;
    const finalizeIo = capture();
    assert.equal(
      await runCli(['recover', '--run', runId, '--domain', 'handoff', '--action', 'finalize'], {
        deps: h.deps,
        io: finalizeIo,
      }),
      0,
      finalizeIo.errorText(),
    );
    assert.equal((await snapshot(h, runId)).events, before, 'journal inchangé');
    assert.equal(h.interactives().length, interactivesAfterHandoff);
    assert.ok(finalizeIo.text().includes('RECOVERY handoff : NONE'));
  } finally {
    await h.cleanup();
  }
});

// ==========================================================================
// F. Notes, instantané périmé, coexistence
// ==========================================================================

test('19–20 · une note humaine est obligatoire, et transmise telle quelle', async () => {
  const h = await harness();
  try {
    const runId = await nativeRun(h);
    const paths = runPaths(h.runsDir, runId);
    let inFlight: Snapshot | undefined;
    const adapters = h.deps.createAdapters('', {} as never);
    const target = adapters.codex;
    const original = target.resume.bind(target);
    (target as { resume: typeof target.resume }).resume = async (session, prompt) => {
      inFlight = { state: await readFile(paths.state, 'utf8'), events: await readFile(paths.events, 'utf8') };
      return original(session, prompt);
    };
    await sendNativeMessage(h.deps, runId, expertSlotTarget('author'), 'question');
    (target as { resume: typeof target.resume }).resume = original;
    assert.ok(inFlight !== undefined);
    await restore(h, runId, inFlight);

    // 19 · sans note, rien n'est écrit.
    const before = await snapshot(h, runId);
    const missing = capture();
    assert.equal(
      await runCli(
        ['recover', '--run', runId, '--domain', 'send', '--action', 'acknowledge-uncertainty'],
        { deps: h.deps, io: missing },
      ),
      2,
    );
    assert.ok(missing.errorText().includes('--note'));
    assert.deepEqual(await snapshot(h, runId), before, 'aucun marqueur');

    // Une note vide n'en est pas une : CCR n'en rédige aucune.
    const empty = capture();
    assert.equal(
      await runCli(
        ['recover', '--run', runId, '--domain', 'send', '--action', 'acknowledge-uncertainty', '--note', '   '],
        { deps: h.deps, io: empty },
      ),
      2,
    );
    assert.deepEqual(await snapshot(h, runId), before);

    // Une note sur un geste qui n'en exige pas est refusée plutôt qu'ignorée.
    const superfluous = capture();
    assert.equal(
      await runCli(
        ['recover', '--run', runId, '--domain', 'send', '--action', 'finalize', '--note', NOTE],
        { deps: h.deps, io: superfluous },
      ),
      2,
    );
    assert.deepEqual(await snapshot(h, runId), before);

    // 20 · fournie, elle atteint le journal bit pour bit.
    const exact = 'Session inspectée à 14 h 02 — « rien de concluant ».';
    const io = capture();
    assert.equal(
      await runCli(
        ['recover', '--run', runId, '--domain', 'send', '--action', 'acknowledge-uncertainty', '--note', exact],
        { deps: h.deps, io },
      ),
      0,
      io.errorText(),
    );
    const marker = (await journal(h, runId)).find(
      (event) => event.type === 'send_uncertainty_acknowledged',
    ) as unknown as Record<string, unknown>;
    assert.equal(marker['content'], exact);
  } finally {
    await h.cleanup();
  }
});

test('21 · un instantané de lecture périmé ne force aucun geste', async () => {
  const h = await harness();
  try {
    const runId = await nativeRun(h);
    let responded: Snapshot | undefined;
    await sendNativeMessage(h.deps, runId, expertSlotTarget('author'), 'question', {
      afterResponseJournaled: async () => {
        responded = await snapshot(h, runId);
      },
    });
    assert.ok(responded !== undefined);
    await restore(h, runId, responded);

    // Instantané A : la finalisation est annoncée disponible.
    const before = await buildNativeRunReadModel({ runsDir: h.runsDir }, runId);
    assert.equal(before.recovery.send.status, 'RESPONSE_NEEDS_FINALIZATION');
    assert.deepEqual(
      before.recovery.send.available_actions.map((action) => action.action),
      ['FINALIZE'],
    );

    // Les faits changent : quelqu'un finalise entre-temps.
    const first = capture();
    assert.equal(
      await runCli(['recover', '--run', runId, '--domain', 'send', '--action', 'finalize'], {
        deps: h.deps,
        io: first,
      }),
      0,
      first.errorText(),
    );

    // La CLI redemande le geste que l'ancien instantané annonçait : la
    // primitive relit sous verrou, et n'invente rien.
    const settled = await snapshot(h, runId);
    const second = capture();
    assert.equal(
      await runCli(['recover', '--run', runId, '--domain', 'send', '--action', 'finalize'], {
        deps: h.deps,
        io: second,
      }),
      0,
      second.errorText(),
    );
    assert.deepEqual(await snapshot(h, runId), settled, 'aucun effet supplémentaire');
    assert.ok(second.text().includes('RECOVERY send : NONE'));
  } finally {
    await h.cleanup();
  }
});

test('22 · deux diagnostics coexistent, et seul le domaine visé change', async () => {
  const h = await harness();
  try {
    const runId = await nativeRun(h);

    // Une ouverture de handoff orpheline — attention durable, non bloquante.
    await forceState(h, runId, { state: 'PAUSED', control: 'HUMAN' });
    let h0: Snapshot | undefined;
    await handoffNativeExpert(h.deps, runId, expertSlotTarget('challenger'), {
      afterStartedJournaled: async () => {
        h0 = await snapshot(h, runId);
      },
    });
    assert.ok(h0 !== undefined);
    await restore(h, runId, h0);

    // …et, par-dessus, un envoi abandonné avant tout appel.
    await forceState(h, runId, { state: 'PAUSED', control: 'HUMAN' });
    let s0: Snapshot | undefined;
    await sendNativeMessage(h.deps, runId, expertSlotTarget('author'), 'question', {
      afterHumanMessageJournaled: async () => {
        s0 = await snapshot(h, runId);
      },
    });
    assert.ok(s0 !== undefined);
    await restore(h, runId, s0);

    const both = await buildNativeRunReadModel({ runsDir: h.runsDir }, runId);
    assert.equal(both.recovery.handoff.status, 'PRE_INTERACTIVE_ABORTED');
    assert.equal(both.recovery.send.status, 'PRE_PROVIDER_ABORTED');

    // Un geste sur `send` ne touche pas le diagnostic de `handoff`.
    const io = capture();
    assert.equal(
      await runCli(
        ['recover', '--run', runId, '--domain', 'send', '--action', 'abort-before-provider'],
        { deps: h.deps, io },
      ),
      0,
      io.errorText(),
    );
    const after = await buildNativeRunReadModel({ runsDir: h.runsDir }, runId);
    assert.equal(after.recovery.send.status, 'NONE');
    assert.equal(after.recovery.handoff.status, 'PRE_INTERACTIVE_ABORTED', 'l’autre attention demeure');
    assert.equal(
      (await journal(h, runId)).filter((event) => event.type === 'handoff_aborted_before_interactive')
        .length,
      0,
      'aucune purge globale',
    );
  } finally {
    await h.cleanup();
  }
});

test('23–25 · l’aide documente la syntaxe, et le rendu vient d’une lecture fraîche', async () => {
  const io = capture();
  assert.equal(await runCli(['--help'], { io }), 0);
  const help = io.text();
  assert.ok(help.includes('--domain initialization --action continue'));
  assert.ok(help.includes('--action acknowledge-uncertainty'));
  assert.ok(help.includes('--note'));
  assert.ok(help.includes('syntaxiques'));
  assert.ok(help.includes('Aucun geste'));
  assert.ok(help.includes('automatiquement'));
  // Aucune option d'auto-réparation n'existe.
  for (const forbidden of ['--fix', '--auto', '--best-effort']) {
    assert.equal(help.includes(forbidden), false, `${forbidden} absent`);
  }
});

test('32 · une résolution de transfert non commitée se termine par la CLI', async () => {
  const h = await harness();
  try {
    const runId = await nativeRun(h);

    // Fenêtre : ouverture de round durable, aucun contexte — la clôture avant
    // appel. Interrompue après son marqueur, elle reste finalisable localement.
    const paths = runPaths(h.runsDir, runId);
    let inFlight: Snapshot | undefined;
    const adapters = h.deps.createAdapters('', {} as never);
    const target = adapters.claude;
    const original = target.resume.bind(target);
    (target as { resume: typeof target.resume }).resume = async (session, prompt) => {
      inFlight = { state: await readFile(paths.state, 'utf8'), events: await readFile(paths.events, 'utf8') };
      return original(session, prompt);
    };
    await stepNativeRun(h.deps, runId);
    (target as { resume: typeof target.resume }).resume = original;
    assert.ok(inFlight !== undefined);

    // Le contexte est retiré : c'est l'abandon avant appel.
    const engaged = JSON.parse(inFlight.state) as Record<string, unknown>;
    await restore(h, runId, {
      state: JSON.stringify({ ...engaged, state: 'RUNNING', pending_operation: null, active_expert_slot: null }),
      events: inFlight.events,
    });

    const calls = h.modelCalls().length;
    const first = capture();
    assert.equal(
      await runCli(['recover', '--run', runId, '--domain', 'step', '--action', 'finalize'], {
        deps: h.deps,
        io: first,
      }),
      0,
      first.errorText(),
    );
    assert.ok(first.text().includes('RECOVERY step : NONE'));
    assert.equal(h.modelCalls().length, calls, 'aucun fournisseur');
    const markers = (await journal(h, runId)).filter(
      (event) => event.type === 'transfer_aborted_before_provider',
    );
    assert.equal(markers.length, 1, 'une clôture durable, et une seule');

    // Redemandé, le même geste ne duplique rien.
    const settled = await snapshot(h, runId);
    const second = capture();
    assert.equal(
      await runCli(['recover', '--run', runId, '--domain', 'step', '--action', 'finalize'], {
        deps: h.deps,
        io: second,
      }),
      0,
      second.errorText(),
    );
    assert.deepEqual(await snapshot(h, runId), settled, 'aucun effet supplémentaire');
  } finally {
    await h.cleanup();
  }
});
