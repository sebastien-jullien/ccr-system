/**
 * Slice 1A — Native Schema Foundation & Legacy Read Boundary.
 *
 * Ce qui est éprouvé ici n'est pas « le code compile », mais quatre propriétés
 * qu'un modèle provider-couplé ne peut pas satisfaire :
 *
 *   1. deux slots peuvent partager le même moteur et rester distincts ;
 *   2. un fournisseur non employé n'est pas observé, et rien ne le fabrique ;
 *   3. un document legacy relu ne change pas de génération ;
 *   4. `experts` et `agents` ne font jamais autorité ensemble.
 *
 * Aucun fournisseur n'est invoqué : ce fichier ne lance aucun processus.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { isCcrError } from '../../src/core/errors.ts';
import type { CcrErrorCode } from '../../src/core/errors.ts';
import { EXPERT_SLOT_IDS, PROVIDER_KINDS, isExpertSlotId, isProviderKind, otherExpertSlot } from '../../src/core/expert.ts';
import type { ExpertSlotId } from '../../src/core/expert.ts';
import { classifyLegacyRoleMapping } from '../../src/core/legacy-projection.ts';
import { MANIFEST_SCHEMA_VERSION, STATE_SCHEMA_VERSION } from '../../src/core/run.ts';
import {
  NATIVE_MANIFEST_SCHEMA_VERSION,
  NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION,
  NATIVE_STATE_SCHEMA_VERSION,
  READABLE_STATE_SCHEMA_VERSIONS,
} from '../../src/core/run-native.ts';
import { runPaths } from '../../src/store/layout.ts';
import { readJsonFile, writeJsonAtomic } from '../../src/store/atomic-file.ts';
import { validateManifest, validateStateDocument, writeState } from '../../src/store/state-store.ts';
import {
  executionModeForManifestSchema,
  readPersistedManifest,
  readPersistedState,
  validateNativeManifest,
  validateNativeRuntimeConfig,
  validateNativeStateDocument,
  validatePersistedManifest,
  validatePersistedState,
} from '../../src/store/native-store.ts';
import {
  FIXTURE_TIME,
  NATIVE_BINDING_PERMUTATIONS,
  conflictingLegacyManifest,
  fixtureManifest,
  materializeNativeRun,
  materializeRun,
  nativeFixtureManifest,
  nativeFixtureState,
  nativeRuntimeConfig,
  nativeSessionId,
  permutationLabel,
} from '../helpers/run-fixture.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const RUN_ID = 'CCR-20260402-001';

function expectCcrError(fn: () => unknown, code: CcrErrorCode, what: string): void {
  assert.throws(fn, (error: unknown) => isCcrError(error) && error.code === code, what);
}

// ==========================================================================
// 1–2. Domaine : deux vocabulaires, une bijection
// ==========================================================================

test('1 · `ExpertSlotId` et `ProviderKind` n’ont aucune valeur commune', () => {
  const shared = EXPERT_SLOT_IDS.filter((slot) => (PROVIDER_KINDS as readonly string[]).includes(slot));
  assert.deepEqual(shared, [], 'aucun slot ne porte un nom de moteur');

  for (const provider of PROVIDER_KINDS) {
    assert.equal(isExpertSlotId(provider), false, `${provider} n’est pas un slot`);
  }
  for (const slot of EXPERT_SLOT_IDS) {
    assert.equal(isProviderKind(slot), false, `${slot} n’est pas un moteur`);
  }
});

test('2 · `otherExpertSlot` est bijectif et sans point fixe', () => {
  assert.equal(otherExpertSlot('author'), 'challenger');
  assert.equal(otherExpertSlot('challenger'), 'author');
  for (const slot of EXPERT_SLOT_IDS) {
    assert.notEqual(otherExpertSlot(slot), slot, 'un slot ne se transfère pas à lui-même');
    assert.equal(otherExpertSlot(otherExpertSlot(slot)), slot, 'involution');
  }
});

// ==========================================================================
// 3–11. Manifest natif (schema 2)
// ==========================================================================

test('3–6 · les quatre permutations de bindings sont acceptées telles quelles', () => {
  for (const bindings of NATIVE_BINDING_PERMUTATIONS) {
    const parsed = validateNativeManifest(nativeFixtureManifest(RUN_ID, bindings));
    assert.equal(parsed.schema_version, NATIVE_MANIFEST_SCHEMA_VERSION);
    assert.equal(parsed.experts.author.provider, bindings.author, permutationLabel(bindings));
    assert.equal(parsed.experts.challenger.provider, bindings.challenger, permutationLabel(bindings));
  }
});

test('7 · `experts.author` absent → MANIFEST_INVALID', () => {
  const manifest = nativeFixtureManifest(RUN_ID, { author: 'codex', challenger: 'claude' }) as unknown as Record<
    string,
    unknown
  >;
  const experts = { ...(manifest['experts'] as Record<string, unknown>) };
  delete experts['author'];
  expectCcrError(() => validateNativeManifest({ ...manifest, experts }), 'MANIFEST_INVALID', 'author absent');
});

test('8 · `experts.challenger` absent → MANIFEST_INVALID', () => {
  const manifest = nativeFixtureManifest(RUN_ID, { author: 'codex', challenger: 'claude' }) as unknown as Record<
    string,
    unknown
  >;
  const experts = { ...(manifest['experts'] as Record<string, unknown>) };
  delete experts['challenger'];
  expectCcrError(() => validateNativeManifest({ ...manifest, experts }), 'MANIFEST_INVALID', 'challenger absent');
});

test('9 · clé de slot supplémentaire → MANIFEST_INVALID', () => {
  const manifest = nativeFixtureManifest(RUN_ID, { author: 'codex', challenger: 'claude' });
  const experts = { ...manifest.experts, referee: { provider: 'claude', session_id: null } };
  expectCcrError(() => validateNativeManifest({ ...manifest, experts }), 'MANIFEST_INVALID', 'troisième slot');
});

test('10 · `agents` et `experts` ne peuvent jamais faire autorité ensemble', () => {
  const native = nativeFixtureManifest(RUN_ID, { author: 'codex', challenger: 'claude' });
  const legacy = fixtureManifest(RUN_ID);
  expectCcrError(
    () => validateNativeManifest({ ...native, agents: legacy.agents }),
    'MANIFEST_INVALID',
    'double autorité',
  );
});

test('11 · provider hors union → MANIFEST_INVALID', () => {
  const manifest = nativeFixtureManifest(RUN_ID, { author: 'codex', challenger: 'claude' });
  expectCcrError(
    () =>
      validateNativeManifest({
        ...manifest,
        experts: { ...manifest.experts, author: { provider: 'gemini', session_id: null } },
      }),
    'MANIFEST_INVALID',
    'moteur inconnu',
  );
});

test('11bis · un `role` dans un slot natif est refusé : la clé porte le rôle', () => {
  const manifest = nativeFixtureManifest(RUN_ID, { author: 'codex', challenger: 'claude' });
  expectCcrError(
    () =>
      validateNativeManifest({
        ...manifest,
        experts: { ...manifest.experts, author: { provider: 'codex', session_id: null, role: 'author' } },
      }),
    'MANIFEST_INVALID',
    'seconde autorité de rôle',
  );
});

test('11ter · les deux validateurs refusent le schéma de l’autre génération', () => {
  const native = nativeFixtureManifest(RUN_ID, { author: 'codex', challenger: 'claude' });
  const legacy = fixtureManifest(RUN_ID);

  expectCcrError(() => validateManifest(native), 'SCHEMA_VERSION_UNSUPPORTED', 'lecteur legacy sur natif');
  expectCcrError(() => validateNativeManifest(legacy), 'SCHEMA_VERSION_UNSUPPORTED', 'lecteur natif sur legacy');

  assert.equal(executionModeForManifestSchema(MANIFEST_SCHEMA_VERSION), 'LEGACY_V2_EXECUTION');
  assert.equal(executionModeForManifestSchema(NATIVE_MANIFEST_SCHEMA_VERSION), 'NATIVE_V21_EXECUTION');
  expectCcrError(() => executionModeForManifestSchema(99), 'SCHEMA_VERSION_UNSUPPORTED', 'génération inconnue');
});

// ==========================================================================
// 12–15. Runs historiques
// ==========================================================================

test('12 · rôles historiques distincts → LEGACY_PROJECTABLE, sémantique d’exécution préservée', () => {
  const mapping = classifyLegacyRoleMapping(fixtureManifest(RUN_ID));
  assert.equal(mapping.kind, 'LEGACY_PROJECTABLE');
  if (mapping.kind !== 'LEGACY_PROJECTABLE') return;

  // La fixture déclare claude=challenger, codex=author : le slot vient du rôle
  // déclaré, le moteur de la clé d’agent. Jamais l’inverse.
  assert.equal(mapping.experts.author.provider, 'codex');
  assert.equal(mapping.experts.author.session_id, 'codex-1');
  assert.equal(mapping.experts.challenger.provider, 'claude');
  assert.equal(mapping.experts.challenger.session_id, 'claude-1');

  // Projeter nomme les acteurs ; cela ne rejoue pas le run selon un protocole
  // postérieur.
  assert.equal(mapping.execution_semantics, 'LEGACY_V2');
});

test('13 · rôles historiques identiques → LEGACY_ROLE_MAPPING_CONFLICT, sans rôle inventé', () => {
  for (const role of ['author', 'challenger'] as const) {
    const mapping = classifyLegacyRoleMapping(conflictingLegacyManifest(RUN_ID, role));
    assert.equal(mapping.kind, 'LEGACY_ROLE_MAPPING_CONFLICT', `deux ${role}`);
    if (mapping.kind !== 'LEGACY_ROLE_MAPPING_CONFLICT') return;
    assert.equal(mapping.duplicated_role, role);
    assert.equal('experts' in mapping, false, 'aucune projection n’est produite pour un run en conflit');
  }
});

test('14 · rôle absent ou hors union → MANIFEST_INVALID, comportement historique inchangé', () => {
  const legacy = fixtureManifest(RUN_ID) as unknown as Record<string, unknown>;
  const agents = legacy['agents'] as Record<string, unknown>;

  expectCcrError(
    () => validateManifest({ ...legacy, agents: { ...agents, claude: { session_id: 'c1' } } }),
    'MANIFEST_INVALID',
    'rôle absent',
  );
  expectCcrError(
    () => validateManifest({ ...legacy, agents: { ...agents, claude: { session_id: 'c1', role: 'referee' } } }),
    'MANIFEST_INVALID',
    'rôle hors union',
  );
});

test('15 · lire et classer un run historique ne touche aucun fichier', async () => {
  const dir = await makeTempDir('ccr-1a-legacy-');
  try {
    const runsDir = path.join(dir, 'runs');
    await materializeRun(runsDir, { runId: RUN_ID });
    const paths = runPaths(runsDir, RUN_ID);

    const before = await Promise.all(
      [paths.manifest, paths.state].map(async (file) => ({
        bytes: await readFile(file, 'utf8'),
        mtime: (await stat(file)).mtimeMs,
      })),
    );

    const persisted = await readPersistedManifest(paths);
    assert.equal(persisted.execution_mode, 'LEGACY_V2_EXECUTION');
    if (persisted.execution_mode !== 'LEGACY_V2_EXECUTION') return;
    classifyLegacyRoleMapping(persisted.manifest);
    await readPersistedState(paths);

    const after = await Promise.all(
      [paths.manifest, paths.state].map(async (file) => ({
        bytes: await readFile(file, 'utf8'),
        mtime: (await stat(file)).mtimeMs,
      })),
    );
    assert.deepEqual(after, before, 'octets et horodatages identiques après lecture et projection');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// 16–20. Snapshot runtime natif (schema 2)
// ==========================================================================

test('16 · un fournisseur requis porte son observation réelle', () => {
  const config = validateNativeRuntimeConfig(nativeRuntimeConfig({ author: 'codex', challenger: 'claude' }));
  assert.equal(config.schema_version, NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION);
  assert.equal(config.claude.required, true);
  assert.equal(config.codex.required, true);
  if (!config.claude.required || !config.codex.required) return;
  assert.equal(config.claude.probe_status, 'OBSERVED');
  assert.equal(config.claude.cli_version, '2.1.224');
  assert.equal(config.codex.skip_git_repo_check, false);
});

test('17 · un fournisseur non employé est `NOT_REQUIRED`', () => {
  const config = validateNativeRuntimeConfig(nativeRuntimeConfig({ author: 'claude', challenger: 'claude' }));
  assert.equal(config.codex.required, false);
  assert.equal(config.codex.probe_status, 'NOT_REQUIRED');
  assert.equal(config.claude.required, true);
});

test('18 · requis + `NOT_REQUIRED` est invalide, et l’inverse aussi', () => {
  const base = nativeRuntimeConfig({ author: 'codex', challenger: 'claude' });

  expectCcrError(
    () =>
      validateNativeRuntimeConfig({
        ...base,
        claude: { required: true, probe_status: 'NOT_REQUIRED', cli_version: null, auth_preflight: 'UNKNOWN' },
      }),
    'MANIFEST_INVALID',
    'requis mais non sondé',
  );

  expectCcrError(
    () =>
      validateNativeRuntimeConfig({
        ...base,
        claude: { required: false, probe_status: 'OBSERVED' },
      }),
    'MANIFEST_INVALID',
    'non requis mais sondé',
  );
});

test('19 · un fournisseur non requis ne peut porter aucune observation factice', () => {
  const base = nativeRuntimeConfig({ author: 'claude', challenger: 'claude' });

  for (const fabricated of [
    { cli_version: '0.146.0' },
    { auth_preflight: 'AUTHENTICATED' },
    { skip_git_repo_check: false },
    { source_at_capture: 'default' },
  ]) {
    expectCcrError(
      () =>
        validateNativeRuntimeConfig({
          ...base,
          codex: { required: false, probe_status: 'NOT_REQUIRED', ...fabricated },
        }),
      'MANIFEST_INVALID',
      `observation fabriquée : ${Object.keys(fabricated).join(',')}`,
    );
  }

  // Et la forme honnête reste minimale : deux champs, aucun autre.
  const config = validateNativeRuntimeConfig(base);
  assert.deepEqual(Object.keys(config.codex).sort(), ['probe_status', 'required']);
});

test('20 · le snapshot runtime historique reste lisible et n’est pas relu comme natif', async () => {
  const dir = await makeTempDir('ccr-1a-runtime-');
  try {
    const runsDir = path.join(dir, 'runs');
    await materializeRun(runsDir, { runId: RUN_ID });
    const persisted = await readPersistedManifest(runPaths(runsDir, RUN_ID));

    assert.equal(persisted.execution_mode, 'LEGACY_V2_EXECUTION');
    if (persisted.execution_mode !== 'LEGACY_V2_EXECUTION') return;
    assert.equal(persisted.manifest.runtime_config?.schema_version, 1, 'version reconduite, non relevée');

    // Le validateur natif refuse un snapshot v1 : aucune promotion silencieuse.
    expectCcrError(
      () => validateNativeRuntimeConfig(persisted.manifest.runtime_config),
      'SCHEMA_VERSION_UNSUPPORTED',
      'snapshot v1 dans un manifest natif',
    );
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// 21–25. État natif (schema 3)
// ==========================================================================

test('21–22 · `next_step_source_slot` accepte les deux slots et `null`', () => {
  for (const slot of [...EXPERT_SLOT_IDS, null] as readonly (ExpertSlotId | null)[]) {
    const parsed = validateNativeStateDocument(nativeFixtureState(RUN_ID, { next_step_source_slot: slot }));
    assert.equal(parsed.next_step_source_slot, slot, `curseur ${String(slot)}`);
    assert.equal(parsed.schema_version, NATIVE_STATE_SCHEMA_VERSION);
  }
});

test('23 · un nom de fournisseur est refusé partout où une identité d’expert est attendue', () => {
  for (const field of ['next_step_source_slot', 'active_expert_slot']) {
    expectCcrError(
      () => validateNativeStateDocument({ ...nativeFixtureState(RUN_ID), [field]: 'claude' }),
      'STATE_INVALID',
      `${field} = claude`,
    );
  }

  // Et les champs legacy nommés par fournisseur ne peuvent pas cohabiter.
  expectCcrError(
    () => validateNativeStateDocument({ ...nativeFixtureState(RUN_ID), active_agent: 'claude' }),
    'STATE_INVALID',
    'active_agent dans un document natif',
  );
  expectCcrError(
    () =>
      validateNativeStateDocument({
        ...nativeFixtureState(RUN_ID),
        uncertainty: { reason: 'r', since: FIXTURE_TIME, agent: 'claude', last_event_id: null },
      }),
    'STATE_INVALID',
    'uncertainty.agent dans un document natif',
  );

  // La forme honnête, elle, passe.
  const ok = validateNativeStateDocument(
    nativeFixtureState(RUN_ID, {
      uncertainty: { reason: 'r', since: FIXTURE_TIME, expert_slot: 'challenger', last_event_id: null },
    }),
  );
  assert.equal(ok.uncertainty?.expert_slot, 'challenger');
});

test('24 · une opération de transfert fige source, cible et événement source', () => {
  const common = {
    round: 1,
    prompt_event_id: null,
    session_id: null,
    return_state: 'RUNNING' as const,
    return_control: 'AUTOMATION' as const,
    started_at: FIXTURE_TIME,
  };
  const step = {
    ...common,
    kind: 'step' as const,
    source_slot: 'author' as const,
    target_slot: 'challenger' as const,
    source_event_id: 'evt-1',
  };
  const send = { ...common, kind: 'send' as const, expert_slot: 'challenger' as const };

  const parsed = validateNativeStateDocument(nativeFixtureState(RUN_ID, { pending_operation: step }));
  const parsedStep = parsed.pending_operation;
  if (parsedStep === null || parsedStep.kind !== 'step') {
    assert.fail('le transfert doit être relu comme un transfert');
  } else {
    assert.equal(parsedStep.source_slot, 'author');
    assert.equal(parsedStep.target_slot, 'challenger');
    assert.equal(parsedStep.source_event_id, 'evt-1');
  }

  for (const [broken, what] of [
    [{ ...step, target_slot: 'author' }, 'source et cible confondues'],
    [{ ...step, source_event_id: '' }, 'transfert sans événement source'],
    [{ ...step, source_slot: 'claude' }, 'source nommée par fournisseur'],
    [{ ...send, expert_slot: 'codex' }, 'slot nommé par fournisseur'],
    [{ ...send, expert_slot: null }, 'opération mono-slot sans slot'],
  ] as readonly (readonly [Record<string, unknown>, string])[]) {
    expectCcrError(
      () => validateNativeStateDocument({ ...nativeFixtureState(RUN_ID), pending_operation: broken }),
      'STATE_INVALID',
      what,
    );
  }

  // Une opération mono-slot n’emprunte pas la forme d’un transfert.
  const parsedSend = validateNativeStateDocument(nativeFixtureState(RUN_ID, { pending_operation: send }));
  const sendOp = parsedSend.pending_operation;
  if (sendOp === null || sendOp.kind === 'step') {
    assert.fail('un message adressé n’est pas un transfert');
  } else {
    assert.equal(sendOp.expert_slot, 'challenger');
    assert.equal('source_slot' in sendOp, false, 'aucun champ de transfert n’est inventé');
  }
});

test('25 · un état legacy relu conserve sa version, y compris après réécriture', async () => {
  const dir = await makeTempDir('ccr-1a-state-');
  try {
    const runsDir = path.join(dir, 'runs');
    await materializeRun(runsDir, { runId: RUN_ID });
    const paths = runPaths(runsDir, RUN_ID);

    // État schema 2 : relu tel quel, jamais relevé en 3.
    const v2 = await readPersistedState(paths);
    assert.equal(v2.execution_mode, 'LEGACY_V2_EXECUTION');
    assert.equal(v2.document.schema_version, STATE_SCHEMA_VERSION);

    // État schema 1 : la version survit à un aller-retour complet lecture →
    // écriture. C’est le point exact où une normalisation montante migrerait un
    // run legacy sans que personne ne l’ait demandé.
    const raw = (await readJsonFile(paths.state)) as Record<string, unknown>;
    const v1Raw: Record<string, unknown> = { ...raw, schema_version: 1 };
    delete v1Raw['pending_operation'];
    await writeJsonAtomic(paths.state, v1Raw);

    const v1 = validateStateDocument(await readJsonFile(paths.state));
    assert.equal(v1.schema_version, 1, 'lecture : version reconduite');

    await writeState(paths, v1);
    assert.equal(
      ((await readJsonFile(paths.state)) as Record<string, unknown>)['schema_version'],
      1,
      'écriture : le document reste dans sa génération',
    );

    // Le lecteur de génération connaît les trois versions ; le lecteur legacy
    // refuse la native.
    assert.deepEqual([...READABLE_STATE_SCHEMA_VERSIONS], [1, 2, 3]);
    expectCcrError(
      () => validateStateDocument(nativeFixtureState(RUN_ID)),
      'SCHEMA_VERSION_UNSUPPORTED',
      'lecteur legacy sur état natif',
    );
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// 26–27. Fixtures et garde structurelle
// ==========================================================================

test('26 · les quatre permutations natives sont générables et relisibles depuis le disque', async () => {
  const dir = await makeTempDir('ccr-1a-native-');
  try {
    const runsDir = path.join(dir, 'runs');
    let ordinal = 0;
    for (const bindings of NATIVE_BINDING_PERMUTATIONS) {
      ordinal += 1;
      const runId = `CCR-20260808-00${ordinal}`;
      await materializeNativeRun(runsDir, { runId, bindings });

      const persisted = await readPersistedManifest(runPaths(runsDir, runId));
      assert.equal(persisted.execution_mode, 'NATIVE_V21_EXECUTION', permutationLabel(bindings));
      if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') return;
      assert.equal(persisted.manifest.experts.author.provider, bindings.author);
      assert.equal(persisted.manifest.experts.challenger.provider, bindings.challenger);

      const state = await readPersistedState(runPaths(runsDir, runId));
      assert.equal(state.execution_mode, 'NATIVE_V21_EXECUTION');
      assert.equal(state.document.schema_version, NATIVE_STATE_SCHEMA_VERSION);
    }
  } finally {
    await removeTempDir(dir);
  }
});

test('27 · en same-provider, les deux slots restent distincts, même sans session', () => {
  for (const provider of PROVIDER_KINDS) {
    const withSessions = validateNativeManifest(
      nativeFixtureManifest(RUN_ID, { author: provider, challenger: provider }),
    );
    assert.equal(withSessions.experts.author.provider, provider);
    assert.equal(withSessions.experts.challenger.provider, provider);
    assert.notEqual(
      withSessions.experts.author.session_id,
      withSessions.experts.challenger.session_id,
      `${provider}/${provider} : deux sessions natives distinctes`,
    );
    assert.equal(withSessions.experts.author.session_id, nativeSessionId('author'));

    // Avant toute session : les slots existent déjà, parce qu’ils sont des clés.
    const bare = validateNativeManifest(
      nativeFixtureManifest(RUN_ID, { author: provider, challenger: provider }, { sessions: 'none' }),
    );
    assert.equal(bare.experts.author.session_id, null);
    assert.equal(bare.experts.challenger.session_id, null);
    assert.deepEqual(Object.keys(bare.experts).sort(), ['author', 'challenger']);
  }
});

test('garde · aucun slot natif n’est déduit d’un fournisseur', () => {
  // Un slot nommé par son moteur est refusé : c’est la forme exacte qu’aurait
  // prise une implémentation qui aurait dérivé l’identité métier du provider.
  const manifest = nativeFixtureManifest(RUN_ID, { author: 'codex', challenger: 'claude' });
  expectCcrError(
    () =>
      validateNativeManifest({
        ...manifest,
        experts: {
          claude: { provider: 'claude', session_id: 'c1' },
          codex: { provider: 'codex', session_id: 'x1' },
        },
      }),
    'MANIFEST_INVALID',
    'slots nommés par moteur',
  );

  // Et la propriété qu’aucune dérivation ne peut satisfaire : pour un même
  // moteur des deux côtés, l’affectation demandée est restituée exactement, et
  // les deux inversions restent discernables l’une de l’autre.
  const claudeAuthor = validateNativeManifest(nativeFixtureManifest(RUN_ID, { author: 'claude', challenger: 'codex' }));
  const codexAuthor = validateNativeManifest(nativeFixtureManifest(RUN_ID, { author: 'codex', challenger: 'claude' }));
  assert.notDeepEqual(claudeAuthor.experts, codexAuthor.experts, 'l’inversion produit un document différent');
  assert.equal(claudeAuthor.experts.author.provider, 'claude');
  assert.equal(codexAuthor.experts.author.provider, 'codex');
});

test('garde · le dispatch de génération ne convertit jamais un document', () => {
  const legacy = validatePersistedManifest(fixtureManifest(RUN_ID));
  assert.equal(legacy.execution_mode, 'LEGACY_V2_EXECUTION');
  if (legacy.execution_mode !== 'LEGACY_V2_EXECUTION') return;
  assert.equal('experts' in legacy.manifest, false, 'aucun champ natif ajouté à un run historique');
  assert.equal(legacy.manifest.schema_version, MANIFEST_SCHEMA_VERSION);

  const native = validatePersistedManifest(nativeFixtureManifest(RUN_ID, { author: 'codex', challenger: 'claude' }));
  assert.equal(native.execution_mode, 'NATIVE_V21_EXECUTION');
  if (native.execution_mode !== 'NATIVE_V21_EXECUTION') return;
  assert.equal('agents' in native.manifest, false, 'aucun champ legacy ajouté à un run natif');

  const nativeState = validatePersistedState(nativeFixtureState(RUN_ID));
  assert.equal(nativeState.execution_mode, 'NATIVE_V21_EXECUTION');
  if (nativeState.execution_mode !== 'NATIVE_V21_EXECUTION') return;
  assert.equal('active_agent' in nativeState.document, false);
  assert.equal('active_expert_slot' in nativeState.document, true);
});

test('garde · un fichier illisible reste illisible, jamais requalifié en autre génération', async () => {
  const dir = await makeTempDir('ccr-1a-corrupt-');
  try {
    const runsDir = path.join(dir, 'runs');
    await materializeRun(runsDir, { runId: RUN_ID });
    const paths = runPaths(runsDir, RUN_ID);

    await writeFile(paths.manifest, '{ pas du json', 'utf8');
    await assert.rejects(
      readPersistedManifest(paths),
      (error: unknown) => isCcrError(error) && error.code === 'MANIFEST_INVALID',
    );

    await writeJsonAtomic(paths.manifest, { ...fixtureManifest(RUN_ID), schema_version: 7 });
    await assert.rejects(
      readPersistedManifest(paths),
      (error: unknown) => isCcrError(error) && error.code === 'SCHEMA_VERSION_UNSUPPORTED',
    );
  } finally {
    await removeTempDir(dir);
  }
});
