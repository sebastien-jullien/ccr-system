/**
 * Slice 2A — Native Target Resolution & Manual Action Guards.
 *
 * La propriété centrale tient en un cas : un run Claude/Claude reste
 * parfaitement adressable par `author` et `challenger`, alors même que l'alias
 * `claude` n'y désigne plus personne. C'est l'alias qui cède, jamais la
 * configuration.
 *
 * Aucun fournisseur, aucun adapter, aucun processus, aucune écriture.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { isCcrError } from '../../src/core/errors.ts';
import type { CcrErrorCode } from '../../src/core/errors.ts';
import { EXPERT_SLOT_IDS, PROVIDER_KINDS } from '../../src/core/expert.ts';
import type { ExpertSlotId, ProviderKind } from '../../src/core/expert.ts';
import { NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION } from '../../src/core/run-native.ts';
import type {
  NativeRunManifest,
  NativeRunRuntimeConfig,
  NativeRunStateDocument,
} from '../../src/core/run-native.ts';
import {
  evaluateNativeManualAction,
  evaluateNativeManualActionForRun,
  expertSlotTarget,
  parseNativeExpertTargetRef,
  providerAliasTarget,
  requireNativeSessionTarget,
  resolveNativeExpertTarget,
  resolveNativeProviderAlias,
} from '../../src/services/native-target-resolver.ts';
import { startRun } from '../../src/services/run-service.ts';
import type { AgentAdapters, RunServiceDeps } from '../../src/services/run-service.ts';
import { runPaths } from '../../src/store/layout.ts';
import {
  buildInitialNativeState,
  writeNativeManifest,
  writeNativeState,
} from '../../src/store/native-store.ts';
import { createFakeAdapter } from '../helpers/fake-adapter.ts';
import { TEST_RUNTIME_CONFIG } from '../helpers/runtime-config.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const RUN_ID = 'CCR-20260811-001';
const AT = '2026-08-11T00:00:00.000Z';

function expectCcrError(fn: () => unknown, code: CcrErrorCode, what: string): void {
  assert.throws(fn, (error: unknown) => isCcrError(error) && error.code === code, what);
}

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

function nativeRuntime(): NativeRunRuntimeConfig {
  return {
    schema_version: NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION,
    captured_at: AT,
    claude: { required: true, probe_status: 'OBSERVED', cli_version: '2.1.224', auth_preflight: 'AUTHENTICATED' },
    codex: {
      required: true,
      probe_status: 'OBSERVED',
      cli_version: '0.146.0',
      auth_preflight: 'AUTHENTICATED',
      skip_git_repo_check: false,
      source_at_capture: 'default',
    },
  };
}

interface Bindings {
  readonly author: ProviderKind;
  readonly challenger: ProviderKind;
}

function manifestOf(
  bindings: Bindings,
  sessions: { readonly author: string | null; readonly challenger: string | null } = {
    author: 'author-session',
    challenger: 'challenger-session',
  },
): NativeRunManifest {
  return {
    schema_version: 2,
    run_id: RUN_ID,
    title: 'T',
    created_at: AT,
    workspace: { cwd: 'E:/prog/exemple' },
    experts: {
      author: { provider: bindings.author, session_id: sessions.author },
      challenger: { provider: bindings.challenger, session_id: sessions.challenger },
    },
    runtime_config: nativeRuntime(),
  };
}

function stateOf(over: Partial<NativeRunStateDocument> = {}): NativeRunStateDocument {
  return {
    ...buildInitialNativeState(RUN_ID, 'READY', new Date(AT)),
    next_step_source_slot: 'author',
    ...over,
  };
}

const MIXED: Bindings = { author: 'codex', challenger: 'claude' };
const INVERTED: Bindings = { author: 'claude', challenger: 'codex' };

// ==========================================================================
// Cibles canoniques — tests 1 à 4
// ==========================================================================

test('1–3 · un slot se résout vers son propre binding, dans les deux permutations', () => {
  for (const [bindings, expected] of [
    [MIXED, { author: 'codex', challenger: 'claude' }],
    [INVERTED, { author: 'claude', challenger: 'codex' }],
  ] as readonly (readonly [Bindings, Record<ExpertSlotId, ProviderKind>])[]) {
    const manifest = manifestOf(bindings);
    for (const slot of EXPERT_SLOT_IDS) {
      const resolved = resolveNativeExpertTarget(manifest, expertSlotTarget(slot));
      assert.equal(resolved.expertSlot, slot);
      assert.equal(resolved.provider, expected[slot], `${slot} → ${expected[slot]}`);
      assert.equal(resolved.sessionId, `${slot}-session`);
    }
  }

  // La forme textuelle passe par une porte unique, et reste discriminée.
  assert.deepEqual(parseNativeExpertTargetRef('author'), { kind: 'expert_slot', value: 'author' });
  assert.deepEqual(parseNativeExpertTargetRef('claude'), { kind: 'provider_alias', value: 'claude' });
  expectCcrError(() => parseNativeExpertTargetRef('referee'), 'INVALID_ARGUMENT', 'cible inconnue');
});

test('4 · une session absente n’est pas un alias non lié', () => {
  const manifest = manifestOf(MIXED, { author: 'codex-1', challenger: null });

  // Le binding du challenger est parfaitement connu…
  const resolved = resolveNativeExpertTarget(manifest, expertSlotTarget('challenger'));
  assert.equal(resolved.provider, 'claude');
  assert.equal(resolved.sessionId, null);

  // …mais il n'est pas joignable, et c'est un refus distinct.
  expectCcrError(
    () => requireNativeSessionTarget(manifest, expertSlotTarget('challenger')),
    'SESSION_MISSING',
    'expert sans session',
  );
  // L'alias, lui, est bien lié : il désigne ce même expert injoignable.
  expectCcrError(
    () => requireNativeSessionTarget(manifest, providerAliasTarget('claude')),
    'SESSION_MISSING',
    'alias lié, session absente',
  );
  assert.equal(
    requireNativeSessionTarget(manifest, expertSlotTarget('author')).sessionId,
    'codex-1',
    "l'autre expert reste joignable",
  );
});

// ==========================================================================
// Alias en configuration mixte — tests 5 à 7
// ==========================================================================

test('5–7 · un alias univoque désigne exactement un slot, et l’inversion inverse le mapping', () => {
  const direct = manifestOf(MIXED);
  assert.equal(resolveNativeProviderAlias(direct, 'codex'), 'author');
  assert.equal(resolveNativeProviderAlias(direct, 'claude'), 'challenger');

  const inverted = manifestOf(INVERTED);
  assert.equal(resolveNativeProviderAlias(inverted, 'codex'), 'challenger');
  assert.equal(resolveNativeProviderAlias(inverted, 'claude'), 'author');

  // Résolution complète : le slot, son moteur, sa session.
  const resolved = resolveNativeExpertTarget(direct, providerAliasTarget('claude'));
  assert.deepEqual(resolved, {
    expertSlot: 'challenger',
    provider: 'claude',
    sessionId: 'challenger-session',
  });
});

// ==========================================================================
// Alias en same-provider — tests 8 à 11
// ==========================================================================

test('8–11 · same-provider : l’alias cède, les deux cibles canoniques restent', () => {
  for (const provider of PROVIDER_KINDS) {
    const other = provider === 'claude' ? 'codex' : 'claude';
    const manifest = manifestOf(
      { author: provider, challenger: provider },
      { author: 'S1', challenger: 'S2' },
    );

    // 8 · 10 · l'alias du moteur employé désigne deux experts : il ne désigne
    // personne, et aucune préférence n'est appliquée.
    expectCcrError(
      () => resolveNativeProviderAlias(manifest, provider),
      'AMBIGUOUS_PROVIDER_ALIAS',
      `${provider}/${provider} · alias ambigu`,
    );

    // 9 · l'alias de l'autre moteur ne désigne personne non plus, mais pour une
    // raison différente — et le code le dit.
    expectCcrError(
      () => resolveNativeProviderAlias(manifest, other),
      'PROVIDER_ALIAS_NOT_BOUND',
      `${provider}/${provider} · alias non lié`,
    );

    // 11 · malgré tout, les deux experts restent adressables et distincts.
    const author = requireNativeSessionTarget(manifest, expertSlotTarget('author'));
    const challenger = requireNativeSessionTarget(manifest, expertSlotTarget('challenger'));
    assert.equal(author.sessionId, 'S1');
    assert.equal(challenger.sessionId, 'S2');
    assert.notEqual(author.sessionId, challenger.sessionId);
    assert.equal(author.provider, challenger.provider, 'même moteur, deux experts');
  }
});

// ==========================================================================
// Aucun rebind — tests 12 et 13
// ==========================================================================

test('12–13 · aucune substitution, jamais : un refus reste un refus', () => {
  const same = manifestOf({ author: 'claude', challenger: 'claude' }, { author: 'S1', challenger: 'S2' });
  const before = JSON.stringify(same);

  expectCcrError(() => resolveNativeProviderAlias(same, 'codex'), 'PROVIDER_ALIAS_NOT_BOUND', 'alias absent');
  expectCcrError(() => resolveNativeProviderAlias(same, 'claude'), 'AMBIGUOUS_PROVIDER_ALIAS', 'alias ambigu');
  assert.equal(JSON.stringify(same), before, 'le manifest est intact');

  // Une cible injoignable ne devient pas l'autre expert.
  const partial = manifestOf(MIXED, { author: null, challenger: 'claude-1' });
  expectCcrError(
    () => requireNativeSessionTarget(partial, expertSlotTarget('author')),
    'SESSION_MISSING',
    'author injoignable',
  );
  const resolved = resolveNativeExpertTarget(partial, expertSlotTarget('author'));
  assert.equal(resolved.expertSlot, 'author', 'la cible reste celle demandée');
  assert.equal(resolved.provider, 'codex', 'son moteur n’est pas remplacé');
});

// ==========================================================================
// Gardes SEND et HANDOFF
// ==========================================================================

test('gardes · SEND et HANDOFF n’ont pas les mêmes règles, et aucune ne touche le contrôle', () => {
  const manifest = manifestOf(MIXED);
  const evaluate = (
    action: 'SEND' | 'HANDOFF',
    state: NativeRunStateDocument,
    slot: ExpertSlotId = 'challenger',
  ): ReturnType<typeof evaluateNativeManualAction> =>
    evaluateNativeManualAction(manifest, state, { action, ref: expertSlotTarget(slot) });

  // SEND reste disponible sous contrôle humain : envoyer un message n'équivaut
  // jamais à rendre le run à l'automatisation.
  const paused = stateOf({ state: 'PAUSED', control: 'HUMAN' });
  assert.equal(evaluate('SEND', paused).verdict.kind, 'ALLOWED');
  assert.equal(evaluate('SEND', stateOf()).verdict.kind, 'ALLOWED', 'et sous automatisation aussi');

  // HANDOFF exige au contraire le contrôle humain **et** un état suspendu.
  assert.equal(evaluate('HANDOFF', paused).verdict.kind, 'ALLOWED');
  const ready = evaluate('HANDOFF', stateOf());
  assert.equal(ready.verdict.kind, 'REFUSED');
  assert.equal(ready.error?.code, 'HANDOFF_NOT_ALLOWED');

  // Une opération engagée bloque les deux : le prédicat historique s'applique.
  const engaged = stateOf({
    state: 'WAITING_AGENT',
    pending_operation: {
      kind: 'step',
      source_slot: 'author',
      target_slot: 'challenger',
      source_event_id: 'evt_000003',
      round: 1,
      prompt_event_id: 'evt_000009',
      session_id: 'challenger-session',
      return_state: 'READY',
      return_control: 'AUTOMATION',
      started_at: AT,
    },
  });
  for (const action of ['SEND', 'HANDOFF'] as const) {
    const refused = evaluate(action, engaged);
    assert.equal(refused.verdict.kind, 'REFUSED', `${action} · opération engagée`);
    assert.equal(refused.error?.code, 'RECOVERY_REQUIRED');
  }

  // Session absente : refus pour les deux, avec la cible tout de même résolue.
  const withoutSession = evaluateNativeManualAction(
    manifestOf(MIXED, { author: 'codex-1', challenger: null }),
    paused,
    { action: 'SEND', ref: expertSlotTarget('challenger') },
  );
  assert.equal(withoutSession.verdict.kind, 'REFUSED');
  assert.equal(withoutSession.error?.code, 'SESSION_MISSING');
  assert.equal(withoutSession.target?.expertSlot, 'challenger');

  // Un alias ambigu est refusé avant toute question d'état.
  const ambiguous = evaluateNativeManualAction(
    manifestOf({ author: 'claude', challenger: 'claude' }),
    paused,
    { action: 'SEND', ref: providerAliasTarget('claude') },
  );
  assert.equal(ambiguous.verdict.kind, 'REFUSED');
  assert.equal(ambiguous.error?.code, 'AMBIGUOUS_PROVIDER_ALIAS');
  assert.equal(ambiguous.target, undefined, 'aucune cible n’est devinée');

  // Et aucune évaluation n'a touché le contrôle : ce sont des fonctions pures.
  assert.equal(paused.control, 'HUMAN');
  assert.equal(stateOf().control, 'AUTOMATION');
});

test('handoff · la résolution fournit exactement ce que le lanceur natif exige', () => {
  const manifest = manifestOf({ author: 'claude', challenger: 'claude' }, { author: 'C1', challenger: 'C2' });
  const target = requireNativeSessionTarget(manifest, expertSlotTarget('challenger'));

  // Rattachement à une session **existante** : le handoff n'en crée aucune, et
  // le coût de l'attache native reste hors contrôle de CCR (frontière V2 gelée).
  assert.deepEqual(target, { expertSlot: 'challenger', provider: 'claude', sessionId: 'C2' });
  assert.notEqual(target.sessionId, manifest.experts.author.session_id);
});

// ==========================================================================
// Legacy et pureté — tests 14 et 15
// ==========================================================================

test('14–15 · un run historique est refusé, et rien n’est jamais écrit', async () => {
  const dir = await makeTempDir('ccr-2a-legacy-');
  try {
    const runsDir = path.join(dir, 'runs');
    const adapters = {
      claude: createFakeAdapter({ kind: 'claude', sessionId: 'claude-1' }),
      codex: createFakeAdapter({ kind: 'codex', sessionId: 'codex-1' }),
    };
    const deps: RunServiceDeps = {
      runsDir,
      now: () => new Date(AT),
      createAdapters: (): AgentAdapters => adapters,
    };
    const started = await startRun(deps, {
      runtimeConfig: TEST_RUNTIME_CONFIG,
      title: 'T',
      cwd: dir,
      prompt: 'mission',
    });
    const legacyPaths = runPaths(runsDir, started.runId);
    const before = {
      manifest: await readFile(legacyPaths.manifest, 'utf8'),
      state: await readFile(legacyPaths.state, 'utf8'),
      events: await readFile(legacyPaths.events, 'utf8'),
    };

    // `send claude` reste provider-canonique dans le moteur historique : V2.1
    // ne réinterprète pas rétroactivement une commande écrite avec un autre sens.
    await assert.rejects(
      evaluateNativeManualActionForRun({ runsDir }, started.runId, {
        action: 'SEND',
        ref: providerAliasTarget('claude'),
      }),
      (error: unknown) => isCcrError(error) && error.code === 'SCHEMA_VERSION_UNSUPPORTED',
      'run historique refusé',
    );

    assert.deepEqual(
      {
        manifest: await readFile(legacyPaths.manifest, 'utf8'),
        state: await readFile(legacyPaths.state, 'utf8'),
        events: await readFile(legacyPaths.events, 'utf8'),
      },
      before,
      'aucune écriture native',
    );

    // ---- Pureté sur un run natif.
    const nativePaths = runPaths(runsDir, RUN_ID);
    await rm(nativePaths.root, { recursive: true, force: true });
    await mkdir(nativePaths.roundsDir, { recursive: true });
    await writeNativeManifest(nativePaths, manifestOf({ author: 'claude', challenger: 'claude' }, { author: 'C1', challenger: 'C2' }));
    await writeNativeState(nativePaths, stateOf({ state: 'PAUSED', control: 'HUMAN' }));

    const snapshot = async (): Promise<Record<string, unknown>> => ({
      manifest: await readFile(nativePaths.manifest, 'utf8'),
      state: await readFile(nativePaths.state, 'utf8'),
      rounds: (await readdir(nativePaths.roundsDir)).sort(),
    });
    const purityBefore = await snapshot();

    for (const action of ['SEND', 'HANDOFF'] as const) {
      const allowed = await evaluateNativeManualActionForRun({ runsDir }, RUN_ID, {
        action,
        ref: expertSlotTarget('author'),
      });
      assert.equal(allowed.verdict.kind, 'ALLOWED', `${action} · cible canonique`);
      assert.equal(allowed.target?.sessionId, 'C1');

      const ambiguous = await evaluateNativeManualActionForRun({ runsDir }, RUN_ID, {
        action,
        ref: providerAliasTarget('claude'),
      });
      assert.equal(ambiguous.error?.code, 'AMBIGUOUS_PROVIDER_ALIAS', `${action} · alias ambigu`);
    }

    assert.deepEqual(await snapshot(), purityBefore, 'aucun octet modifié, aucun round créé');
  } finally {
    await removeTempDir(dir);
  }
});
