/**
 * Slice 2E — Native CLI Surface & Generation Dispatch.
 *
 * La propriété centrale tient en une phrase : **c'est le run qui décide du sens
 * des mots**, pas la ligne de commande. `claude` désigne un agent dans un run
 * historique, et un simple alias de moteur dans un run natif — la génération
 * est donc établie depuis les faits persistés avant que la cible ne soit
 * interprétée.
 *
 * Aucun fournisseur, aucune CLI Claude ou Codex, aucun terminal : tous les
 * adapters sont des fixtures injectées.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { runCli } from '../../src/cli/main.ts';
import type { CliIo } from '../../src/cli/main.ts';
import type { AgentRuntimeProbe } from '../../src/runtime/agent-runtime-probe.ts';
import type { StartPreflightDeps } from '../../src/runtime/preflight-service.ts';
import type { AgentAdapters, RunServiceDeps } from '../../src/services/run-service.ts';
import { startRun } from '../../src/services/run-service.ts';
import type { RunState } from '../../src/core/state.ts';
import { listRunIds, runPaths } from '../../src/store/layout.ts';
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
  readonly adapters: { claude: FakeAdapter; codex: FakeAdapter };
  interactives(): readonly string[];
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

async function harness(options: { sessions?: Partial<Record<'claude' | 'codex', readonly string[]>> } = {}): Promise<
  Harness & { cleanup(): Promise<void> }
> {
  const runsDir = await makeTempDir('ccr-2e-');
  const interactives: string[] = [];
  const build = (kind: 'claude' | 'codex'): FakeAdapter =>
    createFakeAdapter({
      kind,
      startSessionIds: options.sessions?.[kind] ?? [`${kind}-1`, `${kind}-2`],
      sessionId: `${kind}-1`,
      onInteractive: (sessionId) => {
        interactives.push(`${kind}:${sessionId}`);
      },
    });
  const adapters = { claude: build('claude'), codex: build('codex') };
  return {
    runsDir,
    adapters,
    interactives: () => interactives,
    deps: {
      runsDir,
      now: () => new Date(),
      createAdapters: (): AgentAdapters => adapters,
    },
    preflight: fakePreflight(runsDir),
    cleanup: () => removeTempDir(runsDir),
  };
}

async function onlyRunId(runsDir: string): Promise<string> {
  const ids = await listRunIds(runsDir);
  assert.equal(ids.length, 1, 'un seul run');
  return ids[0] ?? '';
}

/** Crée un run natif par la CLI, et rend son identifiant. */
async function startNative(h: Harness, flags: readonly string[] = []): Promise<string> {
  const before = new Set(await listRunIds(h.runsDir));
  const io = capture();
  const code = await runCli(['start', '--title', 'T', '--prompt', 'p', '--cwd', h.runsDir, ...flags], {
    deps: h.deps,
    preflight: h.preflight,
    io,
  });
  assert.equal(code, 0, io.errorText());
  const created = (await listRunIds(h.runsDir)).filter((runId) => !before.has(runId));
  assert.equal(created.length, 1, 'exactement un run créé');
  return created[0] ?? '';
}

async function nativeState(runsDir: string, runId: string): Promise<{
  state: RunState;
  control: 'AUTOMATION' | 'HUMAN';
  cursor: string | null;
  round: number;
}> {
  const persisted = await readPersistedState(runPaths(runsDir, runId));
  if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') throw new Error('état natif attendu');
  return {
    state: persisted.document.state,
    control: persisted.document.control,
    cursor: persisted.document.next_step_source_slot,
    round: persisted.document.round,
  };
}

async function forceNativeState(
  runsDir: string,
  runId: string,
  update: { state: RunState; control?: 'AUTOMATION' | 'HUMAN' },
): Promise<void> {
  const paths = runPaths(runsDir, runId);
  const current = await readPersistedState(paths);
  if (current.execution_mode !== 'NATIVE_V21_EXECUTION') throw new Error('état natif attendu');
  await persistNativeStateUpdate(
    paths,
    current.document,
    { state: update.state, ...(update.control === undefined ? {} : { control: update.control }) },
    new Date(),
  );
}

async function nativeJournal(runsDir: string, runId: string): Promise<string> {
  return readFile(runPaths(runsDir, runId).events, 'utf8');
}

// ==========================================================================
// A. Aiguillage de génération
// ==========================================================================

test('1–4 · un run historique conserve exactement sa sémantique provider', async () => {
  const h = await harness();
  try {
    const legacy = await startRun(h.deps, {
      runtimeConfig: TEST_RUNTIME_CONFIG,
      title: 'historique',
      cwd: 'E:/prog/exemple',
      prompt: 'p',
    });

    // 1 · `send claude` reste une cible provider, servie par le moteur V2.
    const send = capture();
    assert.equal(await runCli(['send', 'claude', 'précision'], { deps: h.deps, io: send }), 0, send.errorText());
    assert.ok(send.text().includes('--- CLAUDE (claude-1) ---'));

    const journal = await readFile(runPaths(h.runsDir, legacy.runId).events, 'utf8');
    // 3 · aucune interprétation ExpertSlot n'a eu lieu.
    assert.ok(journal.includes('"target":"claude"'), 'le journal historique nomme le fournisseur');
    assert.equal(journal.includes('expert_slot_id'), false);
    assert.equal(journal.includes('target_expert_slot_id'), false);

    // 2 · `handoff codex` reste provider-canonique.
    await runCli(['pause'], { deps: h.deps, io: capture() });
    const handoff = capture();
    assert.equal(await runCli(['handoff', 'codex'], { deps: h.deps, io: handoff }), 0, handoff.errorText());
    assert.ok(handoff.text().includes('Handoff codex terminé'));
    assert.deepEqual(h.interactives(), ['codex:codex-1']);

    // 4 · le status historique reste la vue historique.
    const status = capture();
    assert.equal(await runCli(['status'], { deps: h.deps, io: status }), 0);
    assert.equal(status.text().includes('NATIVE_V21_EXECUTION'), false, 'vue historique');
    // La vue historique nomme ses agents par leur moteur, et ne connaît aucune
    // projection native : ni capacités par slot, ni alias, ni reprises.
    assert.ok(status.text().includes('claude'));
    assert.ok(status.text().includes('codex'));
    assert.equal(status.text().includes('reprises'), false, 'aucune projection 2D');
    assert.equal(status.text().includes('alias'), false);
  } finally {
    await h.cleanup();
  }
});

test('5–8 · un run natif est servi par les moteurs natifs, sur le même vocabulaire', async () => {
  const h = await harness();
  try {
    const runId = await startNative(h);
    const manifest = await readPersistedManifest(runPaths(h.runsDir, runId));
    assert.equal(manifest.execution_mode, 'NATIVE_V21_EXECUTION', '6 · la CLI crée du natif');

    // 6 · SEND vers un ExpertSlot.
    const send = capture();
    assert.equal(await runCli(['send', 'author', 'précision'], { deps: h.deps, io: send }), 0, send.errorText());
    assert.ok(send.text().includes('--- AUTHOR (codex-1) ---'), 'la réponse est nommée par son slot');
    const journal = await nativeJournal(h.runsDir, runId);
    assert.ok(journal.includes('"target_expert_slot_id":"author"'));
    assert.equal(journal.includes('"actor":"claude"'), false, 'aucun acteur fournisseur');

    // 5 · STEP par le service natif : curseur et round viennent de lui.
    const before = await nativeState(h.runsDir, runId);
    const step = capture();
    assert.equal(await runCli(['step'], { deps: h.deps, io: step }), 0, step.errorText());
    assert.ok(step.text().includes('author → challenger'));
    const after = await nativeState(h.runsDir, runId);
    assert.equal(after.round, before.round + 1);
    assert.equal(after.cursor, 'challenger');

    // 7 · HANDOFF vers un ExpertSlot, sur un run suspendu.
    await forceNativeState(h.runsDir, runId, { state: 'PAUSED', control: 'HUMAN' });
    const handoff = capture();
    assert.equal(
      await runCli(['handoff', 'challenger'], { deps: h.deps, io: handoff }),
      0,
      handoff.errorText(),
    );
    assert.ok(handoff.text().includes('Handoff « challenger » (claude) terminé'));
    assert.ok(handoff.text().includes('NOT CONTROLLED / NOT MEASURED'));
    assert.deepEqual(h.interactives(), ['claude:claude-1']);

    // 8 · le status natif vient de la projection 2D.
    const status = capture();
    assert.equal(await runCli(['status'], { deps: h.deps, io: status }), 0);
    assert.ok(status.text().includes('NATIVE_V21_EXECUTION'));
    assert.ok(status.text().includes('author'));
    assert.ok(status.text().includes('challenger'));
  } finally {
    await h.cleanup();
  }
});

// ==========================================================================
// B. START
// ==========================================================================

test('9–13 · les quatre permutations de moteurs sont créables, defaults compris', async () => {
  const cases: readonly (readonly [readonly string[], string, string])[] = [
    [[], 'codex', 'claude'],
    [['--author-provider', 'claude', '--challenger-provider', 'codex'], 'claude', 'codex'],
    [['--author-provider', 'claude', '--challenger-provider', 'claude'], 'claude', 'claude'],
    [['--author-provider', 'codex', '--challenger-provider', 'codex'], 'codex', 'codex'],
    // 13 · l'ordre des options n'a aucune importance.
    [['--challenger-provider', 'codex', '--author-provider', 'claude'], 'claude', 'codex'],
  ];

  for (const [flags, author, challenger] of cases) {
    const h = await harness({ sessions: { claude: ['C1', 'C2'], codex: ['X1', 'X2'] } });
    try {
      const runId = await startNative(h, flags);
      const manifest = await readPersistedManifest(runPaths(h.runsDir, runId));
      if (manifest.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('run natif attendu');
      assert.equal(manifest.manifest.experts.author.provider, author, flags.join(' '));
      assert.equal(manifest.manifest.experts.challenger.provider, challenger, flags.join(' '));
      // Same-provider : deux sessions distinctes, jamais une seule.
      assert.notEqual(
        manifest.manifest.experts.author.session_id,
        manifest.manifest.experts.challenger.session_id,
      );
    } finally {
      await h.cleanup();
    }
  }
});

test('14–16 · les anciennes options de rôle ne survivent que bijectives, et jamais mélangées', async () => {
  // 14 · un couple bijectif décrit exactement un run natif.
  const bijective = await harness();
  try {
    const io = capture();
    const code = await runCli(
      ['start', '--title', 'T', '--prompt', 'p', '--claude-role', 'author', '--codex-role', 'challenger'],
      { deps: bijective.deps, preflight: bijective.preflight, io },
    );
    assert.equal(code, 0, io.errorText());
    const runId = await onlyRunId(bijective.runsDir);
    const manifest = await readPersistedManifest(runPaths(bijective.runsDir, runId));
    if (manifest.execution_mode !== 'NATIVE_V21_EXECUTION') return assert.fail('run natif attendu');
    assert.equal(manifest.manifest.experts.author.provider, 'claude');
    assert.equal(manifest.manifest.experts.challenger.provider, 'codex');
  } finally {
    await bijective.cleanup();
  }

  // 15–16 · non bijectif, et mélange des deux familles : refus d'usage avant
  // la moindre allocation.
  const refusals: readonly (readonly [string, readonly string[]])[] = [
    ['deux author', ['--claude-role', 'author', '--codex-role', 'author']],
    ['un seul rôle', ['--claude-role', 'author']],
    ['familles mélangées', ['--author-provider', 'claude', '--codex-role', 'challenger']],
  ];
  for (const [label, flags] of refusals) {
    const h = await harness();
    try {
      const io = capture();
      const code = await runCli(['start', '--title', 'T', '--prompt', 'p', ...flags], {
        deps: h.deps,
        preflight: h.preflight,
        io,
      });
      assert.equal(code, 2, `${label} : erreur d'usage`);
      assert.deepEqual(await listRunIds(h.runsDir), [], `${label} : aucun run alloué`);
      assert.equal(h.adapters.claude.calls.length + h.adapters.codex.calls.length, 0, `${label} : aucun appel`);
    } finally {
      await h.cleanup();
    }
  }
});

// ==========================================================================
// C. Alias de compatibilité
// ==========================================================================

test('17–22 · les alias fournisseur suivent la règle 0/1/2, sans seconde résolution', async () => {
  // 17–18 · configuration mixte : l'alias désigne un seul expert.
  const mixed = await harness();
  try {
    const runId = await startNative(mixed);
    const send = capture();
    assert.equal(await runCli(['send', 'claude', 'via alias'], { deps: mixed.deps, io: send }), 0);
    assert.ok(send.text().includes('--- CHALLENGER (claude-1) ---'), 'claude → challenger');

    await forceNativeState(mixed.runsDir, runId, { state: 'PAUSED', control: 'HUMAN' });
    const handoff = capture();
    assert.equal(await runCli(['handoff', 'codex'], { deps: mixed.deps, io: handoff }), 0);
    assert.ok(handoff.text().includes('Handoff « author » (codex) terminé'), 'codex → author');
  } finally {
    await mixed.cleanup();
  }

  // 19–22 · same-provider : l'alias devient inutilisable, les slots non.
  const same = await harness({ sessions: { claude: ['C1', 'C2'] } });
  try {
    const runId = await startNative(same, ['--author-provider', 'claude', '--challenger-provider', 'claude']);

    const ambiguous = capture();
    assert.equal(await runCli(['send', 'claude', 'message'], { deps: same.deps, io: ambiguous }), 1);
    assert.ok(ambiguous.errorText().includes('AMBIGUOUS_PROVIDER_ALIAS'));

    const absent = capture();
    assert.equal(await runCli(['send', 'codex', 'message'], { deps: same.deps, io: absent }), 1);
    assert.ok(absent.errorText().includes('PROVIDER_ALIAS_NOT_BOUND'));

    // 20–21 · les cibles canoniques restent parfaitement utilisables.
    const author = capture();
    assert.equal(await runCli(['send', 'author', 'à l’auteur'], { deps: same.deps, io: author }), 0);
    assert.ok(author.text().includes('--- AUTHOR (C1) ---'));
    const challenger = capture();
    assert.equal(await runCli(['send', 'challenger', 'au contradicteur'], { deps: same.deps, io: challenger }), 0);
    assert.ok(challenger.text().includes('--- CHALLENGER (C2) ---'));

    // Un refus d'alias n'a rien écrit d'autre que les deux envois canoniques.
    const journal = await nativeJournal(same.runsDir, runId);
    assert.equal((journal.match(/"type":"human_message"/g) ?? []).length, 2);
  } finally {
    await same.cleanup();
  }
});

// ==========================================================================
// D. Status natif
// ==========================================================================

test('23–27 · le status natif est une mise en forme de la projection 2D', async () => {
  const h = await harness({ sessions: { claude: ['C1', 'C2'] } });
  try {
    const runId = await startNative(h, ['--author-provider', 'claude', '--challenger-provider', 'claude']);

    // 24 · same-provider : deux experts, deux sessions, jamais fusionnés.
    const status = capture();
    assert.equal(await runCli(['status'], { deps: h.deps, io: status }), 0);
    assert.ok(status.text().includes('author'));
    assert.ok(status.text().includes('challenger'));
    assert.ok(status.text().includes('C1'));
    assert.ok(status.text().includes('C2'));
    // Les alias sont montrés comme compatibilité, avec leur verdict.
    assert.ok(status.text().includes('claude → AMBIGUOUS'));
    assert.ok(status.text().includes('codex → NOT_BOUND'));
    // 26 · les quatre reprises viennent de 2D, avec leur vocabulaire.
    assert.ok(status.text().includes('reprises'));
    assert.ok(status.text().includes('initialisation NONE'));

    // 25 · la barrière de fraîcheur post-handoff est **présentée**, pas
    // recalculée : un handoff sur le slot du curseur, puis lecture.
    await forceNativeState(h.runsDir, runId, { state: 'PAUSED', control: 'HUMAN' });
    assert.equal(await runCli(['handoff', 'author'], { deps: h.deps, io: capture() }), 0);
    // Rendu à l'automatisation, le run est par ailleurs transférable : c'est
    // bien la barrière — et elle seule — qui refuse.
    await forceNativeState(h.runsDir, runId, { state: 'READY', control: 'AUTOMATION' });
    const stale = capture();
    assert.equal(await runCli(['status'], { deps: h.deps, io: stale }), 0);
    assert.ok(stale.text().includes('SOURCE_STALE_AFTER_HANDOFF'));
    assert.ok(stale.text().includes('handoff NONE'), 'aucune reprise n’est pourtant nécessaire');
  } finally {
    await h.cleanup();
  }
});

test('27 · la CLI ne recalcule aucune règle métier', async () => {
  const sources = await Promise.all(
    ['main.ts', 'native-dispatch.ts', 'native-format.ts'].map(async (file) =>
      readFile(new URL(`../../src/cli/${file}`, import.meta.url), 'utf8'),
    ),
  );
  const code = sources
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');

  // Aucune décision métier : ni garde, ni sélection de source, ni alias résolu
  // à la main, ni provider déduit d'un slot.
  for (const forbidden of [
    'resolveNativeProviderAlias',
    'resolveNativeExpertTarget',
    'evaluateNativeManualAction',
    'planNativeStep',
    'nativeGuardFacts',
    'sendGuard',
    'handoffGuard',
    "=== 'PAUSED'",
    "=== 'claude'",
    "=== 'codex'",
  ]) {
    assert.equal(code.includes(forbidden), false, `${forbidden} absent de la CLI`);
  }
  // La seule porte d'entrée des cibles natives est celle de 2A.
  assert.ok(code.includes('parseNativeExpertTargetRef'));
});

// ==========================================================================
// E. Sûreté de `recover`
// ==========================================================================

test('29–31 · `recover` ne touche jamais un run natif', async () => {
  const h = await harness();
  try {
    // 29 · sur un run historique, la reprise historique reste inchangée.
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

    // 30 · sur un run natif, refus explicite, sans écriture.
    const runId = await startNative(h);
    const paths = runPaths(h.runsDir, runId);
    const before = {
      state: await readFile(paths.state, 'utf8'),
      events: await readFile(paths.events, 'utf8'),
      manifest: await readFile(paths.manifest, 'utf8'),
    };

    // Depuis 2E-R, la reprise native existe — mais elle exige un geste nommé.
    // Sans domaine ni action, la commande n'écrit rien et rend l'inventaire.
    const io = capture();
    assert.equal(await runCli(['recover', '--run', runId], { deps: h.deps, io }), 2);
    assert.ok(io.text().includes('reprises natives'));
    assert.equal(io.errorText().includes('SCHEMA_VERSION_UNSUPPORTED'), false);
    assert.equal(await readFile(paths.state, 'utf8'), before.state);
    assert.equal(await readFile(paths.events, 'utf8'), before.events);
    assert.equal(await readFile(paths.manifest, 'utf8'), before.manifest);

    // 31 · aucune primitive de reprise native n'a été appelée : le journal ne
    // porte aucun marqueur de clôture, et aucun état n'a bougé.
    const events = await (
      await openNativeEventStore(paths, (await readPersistedManifest(paths)).manifest as never)
    ).readAll();
    assert.equal(
      events.some((event) => event.type.includes('acknowledged') || event.type.includes('aborted')),
      false,
    );
  } finally {
    await h.cleanup();
  }
});

// ==========================================================================
// F. Aide
// ==========================================================================

test('28 · l’aide met en avant les experts, et signale les alias comme compatibilité', async () => {
  const io = capture();
  assert.equal(await runCli(['--help'], { io }), 0);
  const help = io.text();
  assert.ok(help.includes('ccr send   <author|challenger>'));
  assert.ok(help.includes('ccr handoff <author|challenger>'));
  assert.ok(help.includes('--author-provider'));
  assert.ok(help.includes('--challenger-provider'));
  assert.ok(help.includes('alias de compatibilité'));
  assert.ok(help.includes('dépréciés'));
  // Sur un run historique, la cible reste celle d'origine.
  assert.ok(help.includes('la cible reste <claude|codex>'));
});

// ==========================================================================
// G. V2.1-IMP-16 — LIST bi-génération et contrôle humain
// ==========================================================================

test('32–34 · `list` lit les deux générations, et ne masque pas une vraie corruption', async () => {
  const h = await harness();
  try {
    // 32 · un run historique reste lisible exactement comme avant.
    await startRun(h.deps, {
      runtimeConfig: TEST_RUNTIME_CONFIG,
      title: 'historique',
      cwd: 'E:/prog/exemple',
      prompt: 'p',
    });
    // 33 · deux runs natifs, distingués par leurs vrais états.
    const first = await startNative(h);
    const second = await startNative(h);
    await forceNativeState(h.runsDir, first, { state: 'PAUSED', control: 'HUMAN' });

    const io = capture();
    assert.equal(await runCli(['list'], { deps: h.deps, io }), 0, io.errorText());
    const text = io.text();
    assert.equal(text.includes('(illisible)'), false, 'aucun run sain n’est déclaré illisible');
    assert.ok(text.includes('READY   historique'), 'run historique lisible, et nommé comme tel');
    assert.ok(text.includes(`${first}  PAUSED  natif`), 'premier run natif, état réel');
    assert.ok(text.includes(`${second}  READY   natif`), 'second run natif, état distinct');

    // 34 · une version de schéma qu'aucune génération ne connaît reste
    // illisible : la compatibilité native ne couvre pas une corruption.
    const corrupted = await startNative(h);
    const paths = runPaths(h.runsDir, corrupted);
    const manifest = JSON.parse(await readFile(paths.manifest, 'utf8')) as Record<string, unknown>;
    await writeFile(paths.manifest, JSON.stringify({ ...manifest, schema_version: 99 }), 'utf8');

    const after = capture();
    assert.equal(await runCli(['list'], { deps: h.deps, io: after }), 0);
    assert.ok(after.text().includes(`${corrupted}  ILLISIBLE`));
    assert.ok(after.text().includes('[SCHEMA_VERSION_UNSUPPORTED]'));
  } finally {
    await h.cleanup();
  }
});

test('35–37 · pause et resume sont servis par le moteur de la génération visée', async () => {
  const h = await harness();
  try {
    const runId = await startNative(h);

    // 35 · un run natif automatisé devient suspendu — et le handoff, refusé
    // jusque-là, devient atteignable volontairement.
    const refused = capture();
    assert.equal(await runCli(['handoff', 'author'], { deps: h.deps, io: refused }), 1);
    assert.ok(refused.errorText().includes('HANDOFF_NOT_ALLOWED'));

    const paused = capture();
    assert.equal(await runCli(['pause'], { deps: h.deps, io: paused }), 0, paused.errorText());
    assert.ok(paused.text().includes('suspendu'));
    const suspended = await nativeState(h.runsDir, runId);
    assert.equal(suspended.state, 'PAUSED');
    assert.equal(suspended.control, 'HUMAN');
    assert.equal(suspended.cursor, 'author', 'le curseur traverse la suspension');

    const handoff = capture();
    assert.equal(await runCli(['handoff', 'author'], { deps: h.deps, io: handoff }), 0, handoff.errorText());

    // 36 · la reprise rend le contrôle, sans lancer le moindre agent.
    const callsBefore = h.adapters.claude.calls.length + h.adapters.codex.calls.length;
    const resumed = capture();
    assert.equal(await runCli(['resume'], { deps: h.deps, io: resumed }), 0, resumed.errorText());
    assert.ok(resumed.text().includes('automatisation'));
    const back = await nativeState(h.runsDir, runId);
    assert.equal(back.state, 'READY');
    assert.equal(back.control, 'AUTOMATION');
    assert.equal(h.adapters.claude.calls.length + h.adapters.codex.calls.length, callsBefore);

    // 37 · le journal natif porte les deux événements neutres.
    const journal = await nativeJournal(h.runsDir, runId);
    assert.ok(journal.includes('"type":"run_paused"'));
    assert.ok(journal.includes('"type":"run_resumed"'));

    // Le status natif expose les mêmes verdicts que les services.
    const status = capture();
    assert.equal(await runCli(['status'], { deps: h.deps, io: status }), 0);
    assert.ok(status.text().includes('pause : autorisé'));
    assert.ok(status.text().includes('resume : sans effet'));
  } finally {
    await h.cleanup();
  }
});

test('38–41 · la cible implicite ne saute plus un run natif au profit d’un legacy', async () => {
  const h = await harness();
  try {
    // Un run historique **plus ancien**, puis un run natif plus récent. La
    // résolution historique lisait le premier et sautait le second : les quatre
    // commandes de contrôle mutaient alors le mauvais run, en rapportant un
    // succès.
    const legacy = await startRun(h.deps, {
      runtimeConfig: TEST_RUNTIME_CONFIG,
      title: 'ancien',
      cwd: 'E:/prog/exemple',
      prompt: 'p',
    });
    const native = await startNative(h);
    const legacyPaths = runPaths(h.runsDir, legacy.runId);
    const legacyBefore = {
      state: await readFile(legacyPaths.state, 'utf8'),
      events: await readFile(legacyPaths.events, 'utf8'),
    };

    // 38 · `pause` implicite vise le run natif.
    const paused = capture();
    assert.equal(await runCli(['pause'], { deps: h.deps, io: paused }), 0, paused.errorText());
    assert.ok(paused.text().includes(native));
    assert.equal((await nativeState(h.runsDir, native)).state, 'PAUSED');

    // 39 · `resume` implicite vise le même run natif.
    const resumed = capture();
    assert.equal(await runCli(['resume'], { deps: h.deps, io: resumed }), 0, resumed.errorText());
    assert.ok(resumed.text().includes(native));
    assert.equal((await nativeState(h.runsDir, native)).control, 'AUTOMATION');

    // 40 · `decide` et `stop` restent différés — mais refusés **sur le run
    // natif**, jamais détournés vers l'ancien.
    for (const argv of [['decide', 'une décision'], ['stop']]) {
      const io = capture();
      assert.equal(await runCli(argv, { deps: h.deps, io }), 1, argv[0]);
      assert.ok(io.errorText().includes('COMMAND_UNSUPPORTED_FOR_GENERATION'), argv[0]);
      assert.ok(io.errorText().includes(native), `${String(argv[0])} nomme le run natif visé`);
    }

    // 41 · le run historique n'a pas bougé d'un octet.
    assert.equal(await readFile(legacyPaths.state, 'utf8'), legacyBefore.state);
    assert.equal(await readFile(legacyPaths.events, 'utf8'), legacyBefore.events);
    await assert.rejects(readFile(legacyPaths.decisions, 'utf8'), 'aucune décision écrite');
  } finally {
    await h.cleanup();
  }
});

test('42–43 · nommé explicitement, un run historique garde ses services historiques', async () => {
  const h = await harness();
  try {
    const legacy = await startRun(h.deps, {
      runtimeConfig: TEST_RUNTIME_CONFIG,
      title: 'ancien',
      cwd: 'E:/prog/exemple',
      prompt: 'p',
    });
    await startNative(h);

    // 42 · `decide` sur le run historique nommé : comportement V1 inchangé.
    const decide = capture();
    assert.equal(
      await runCli(['decide', 'gouvernance arbitrée', '--run', legacy.runId], { deps: h.deps, io: decide }),
      0,
      decide.errorText(),
    );
    assert.ok(decide.text().includes('enregistrée'));
    assert.ok(
      (await readFile(runPaths(h.runsDir, legacy.runId).decisions, 'utf8')).includes('gouvernance arbitrée'),
    );

    // 43 · `pause` puis `stop` sur ce même run historique.
    const paused = capture();
    assert.equal(await runCli(['pause', '--run', legacy.runId], { deps: h.deps, io: paused }), 0);
    const stopped = capture();
    assert.equal(await runCli(['stop', '--run', legacy.runId], { deps: h.deps, io: stopped }), 0);
    assert.ok(stopped.text().includes('clos'));
  } finally {
    await h.cleanup();
  }
});
