/**
 * V2.3-S1 — projection de présentation du cockpit.
 *
 * Une seule question de preuve gouverne ce fichier :
 *
 * > **Les faits publiés par la projection sont-ils autoritaires et vrais ?**
 *
 * Trois propriétés la portent.
 *
 *  1. **Un seul instantané.** La projection native et la présentation viennent
 *     du même snapshot, donc de la même révision. Deux lectures décriraient
 *     deux mondes sous une seule empreinte.
 *  2. **Aucune règle rejouée.** La présentation ne recalcule ni capacité, ni
 *     statut de reprise, ni transition d'état — elle compose et référence.
 *  3. **Aucun chiffre inventé.** `AT_MOST` existe parce que `START` ne consomme
 *     pas un nombre fixe, et `UNKNOWN` parce qu'un handoff n'est pas
 *     déclenchable d'ici.
 *
 * Aucun fournisseur, aucun processus, aucun navigateur, aucun run REAL.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { EXPERT_SLOT_IDS } from '../../src/core/expert.ts';
import type { ExpertSlotId, ProviderKind } from '../../src/core/expert.ts';
import {
  NATIVE_MANIFEST_SCHEMA_VERSION,
  NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION,
  NATIVE_STATE_SCHEMA_VERSION,
} from '../../src/core/run-native.ts';
import type { NativeRunManifest, NativeRunStateDocument } from '../../src/core/run-native.ts';
import { runPaths } from '../../src/store/layout.ts';
import { openNativeEventStore } from '../../src/store/native-event-store.ts';
import type { NativeEventStore } from '../../src/store/native-event-store.ts';
import { writeNativeManifest, writeNativeState } from '../../src/store/native-store.ts';
import { readStableNativeRunSnapshot } from '../../src/store/native-run-snapshot.ts';
import {
  COCKPIT_PRESENTATION_VERSION,
  projectCockpitPresentation,
} from '../../src/services/cockpit-presentation.ts';
import {
  COCKPIT_OPERATION_IDS,
  NATIVE_OPERATION_SERVICE,
  operationEffect,
  providerProducingOperations,
} from '../../src/services/invocation-effect.ts';
import type { CockpitOperationId } from '../../src/services/invocation-effect.ts';
import { readNativeRunHttpView } from '../../src/cockpit/native-read-http.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const RUN_ID = 'CCR-20260811-002';
const AT = '2026-08-11T00:00:00.000Z';
const MISSION = 'Mission initiale : évaluer la refonte du cockpit.';

interface Bindings {
  readonly author: ProviderKind;
  readonly challenger: ProviderKind;
}

function manifestOf(
  bindings: Bindings,
  sessions: { author: string | null; challenger: string | null },
): NativeRunManifest {
  return {
    schema_version: NATIVE_MANIFEST_SCHEMA_VERSION,
    run_id: RUN_ID,
    title: 'Contre-expertise',
    created_at: AT,
    workspace: { cwd: 'E:/prog/exemple' },
    experts: {
      author: { provider: bindings.author, session_id: sessions.author },
      challenger: { provider: bindings.challenger, session_id: sessions.challenger },
    },
    runtime_config: {
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
    },
  };
}

function stateOf(over: Partial<NativeRunStateDocument> = {}): NativeRunStateDocument {
  return {
    schema_version: NATIVE_STATE_SCHEMA_VERSION,
    run_id: RUN_ID,
    state: 'READY',
    control: 'AUTOMATION',
    round: 0,
    active_expert_slot: null,
    next_step_source_slot: 'author',
    last_event_id: null,
    pending_operation: null,
    uncertainty: null,
    updated_at: AT,
    ...over,
  };
}

/** Initialisation d'un slot : le prompt humain verbatim, puis la réponse. */
async function startSlot(
  events: NativeEventStore,
  slot: ExpertSlotId,
  session: string,
  prompt: string = MISSION,
): Promise<void> {
  const promptEvent = await events.append({
    round: 0,
    actor: 'human',
    type: 'prompt_sent',
    target_expert_slot_id: slot,
    content: prompt,
    timestamp: AT,
  });
  await events.append({
    round: 0,
    actor: 'expert',
    type: 'assistant_response',
    expert_slot_id: slot,
    session_id: session,
    content: `position initiale de ${slot}`,
    exit_code: 0,
    based_on: [promptEvent.event_id],
    timestamp: AT,
  });
  await events.append({
    round: 0,
    actor: 'system',
    type: 'session_created',
    expert_slot_id: slot,
    session_id: session,
    timestamp: AT,
  });
}

interface Fixture {
  readonly runsDir: string;
  readonly paths: ReturnType<typeof runPaths>;
  readonly events: NativeEventStore;
  readonly sessions: { author: string; challenger: string };
}

async function nativeRun(
  dir: string,
  options: {
    bindings?: Bindings;
    prompts?: { author?: string; challenger?: string };
    onlyAuthor?: boolean;
  } = {},
): Promise<Fixture> {
  const runsDir = path.join(dir, 'runs');
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.roundsDir, { recursive: true });
  const bindings = options.bindings ?? { author: 'codex', challenger: 'claude' };
  const sessions = { author: 'session-auteur', challenger: 'session-challenger' };
  const manifest = manifestOf(bindings, {
    author: sessions.author,
    challenger: options.onlyAuthor === true ? null : sessions.challenger,
  });
  await writeNativeManifest(paths, manifest);
  await writeNativeState(paths, stateOf());
  const events = await openNativeEventStore(paths, manifest);
  await startSlot(events, 'author', sessions.author, options.prompts?.author ?? MISSION);
  if (options.onlyAuthor !== true) {
    await startSlot(events, 'challenger', sessions.challenger, options.prompts?.challenger ?? MISSION);
  }
  return { runsDir, paths, events, sessions };
}

/** Source exécutable : commentaires retirés, jamais la prose. */
async function executable(relative: string): Promise<string> {
  const raw = await readFile(new URL(`../../src/${relative}`, import.meta.url), 'utf8');
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

// ==========================================================================
// A. Forme et cohérence d'instantané
// ==========================================================================

test('1–3 · projection additive, versionnée, issue du même instantané', async () => {
  const dir = await makeTempDir('ccr-s1-shape-');
  try {
    const f = await nativeRun(dir);

    // 1 · la version de projection est publiée, et distincte du read model.
    const view = await readNativeRunHttpView({ runsDir: f.runsDir }, RUN_ID);
    assert.equal(view.presentation.presentation_version, COCKPIT_PRESENTATION_VERSION);
    // Deux versions **indépendantes** : la présentation porte la sienne et ne
    // la dérive pas de celle du read model. Leur valeur peut coïncider ; leur
    // couplage, non — la garde de source du test 13 l'interdit.
    assert.equal(typeof view.run.read_model_version, 'number');

    // 2 · 3 · la présentation d'un snapshot relu à l'identique est la même, et
    //     la révision de la vue est celle de ce snapshot.
    const snapshot = await readStableNativeRunSnapshot(f.runsDir, RUN_ID);
    assert.equal(view.revision, snapshot.revision);
    assert.deepEqual(projectCockpitPresentation(snapshot), view.presentation);

    // Le modèle natif n'est pas altéré par la composition.
    assert.equal(view.run.identity.run_id, RUN_ID);
    assert.equal(view.run.identity.execution_mode, 'NATIVE_V21_EXECUTION');
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// B. Effets d'invocation — preuve comportementale
// ==========================================================================

test('4–9 · chaque opération publie son effet exact', () => {
  const expected: Record<CockpitOperationId, { provider: string; effect: unknown }> = {
    STEP: { provider: 'YES', effect: { kind: 'EXACT', count: 1 } },
    SEND: { provider: 'YES', effect: { kind: 'EXACT', count: 1 } },
    START: { provider: 'YES', effect: { kind: 'AT_MOST', count: 2 } },
    PAUSE: { provider: 'NO', effect: { kind: 'EXACT', count: 0 } },
    RESUME: { provider: 'NO', effect: { kind: 'EXACT', count: 0 } },
    HANDOFF: { provider: 'NOT_AVAILABLE', effect: { kind: 'UNKNOWN' } },
  };

  for (const operation of COCKPIT_OPERATION_IDS) {
    const effect = operationEffect(operation);
    const want = expected[operation];
    assert.equal(effect.may_call_provider, want.provider, `${operation} · appel fournisseur`);
    assert.deepEqual(effect.invocation_effect, want.effect, `${operation} · effet d’invocation`);
  }

  // 6 · le point précis que la falsification vise : START n'est PAS EXACT(2).
  const start = operationEffect('START');
  assert.equal(start.invocation_effect.kind, 'AT_MOST', 'START ne consomme pas un nombre fixe');
  assert.notDeepEqual(start.invocation_effect, { kind: 'EXACT', count: 2 });

  // Aucun chiffre n'accompagne un effet inconnu.
  assert.equal('count' in operationEffect('HANDOFF').invocation_effect, false);
});

test('10 · pourquoi EXACT(2) serait faux — une initialisation partielle', async () => {
  const dir = await makeTempDir('ccr-s1-partial-');
  try {
    // Un run dont un seul slot est lié : le second reste à initialiser.
    const f = await nativeRun(dir, { onlyAuthor: true });
    const view = await readNativeRunHttpView({ runsDir: f.runsDir }, RUN_ID);

    assert.equal(view.run.experts.author.session_status, 'BOUND');
    assert.equal(view.run.experts.challenger.session_status, 'MISSING');

    // Un seul slot reste à initialiser : compléter ce run n'engagerait donc
    // qu'une invocation, et non deux. C'est exactement ce qu'AT_MOST(2)
    // autorise et qu'EXACT(2) interdirait.
    const missing = EXPERT_SLOT_IDS.filter((slot) => view.run.experts[slot].session_status === 'MISSING');
    assert.equal(missing.length, 1);
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// C. Garde structurelle anti-dérive
// ==========================================================================

test('11–12 · la table d’effets est un miroir vérifié des chemins réels', async () => {
  const servicesDir = new URL('../../src/services/', import.meta.url);
  const entries = await readdir(servicesDir);
  const nativeServices = entries.filter((name) => /^native-.*-service\.ts$/.test(name));
  assert.ok(nativeServices.length >= 5, 'le balayage doit voir les services natifs');

  const withQuotaAssertion: string[] = [];
  for (const name of nativeServices) {
    const source = await executable(`services/${name}`);
    if (source.includes('assertInvocationQuotaAvailable')) withQuotaAssertion.push(name);
  }

  // 11 · l'ensemble des services natifs qui engagent une invocation est
  //      EXACTEMENT celui que la primitive déclare. Un service ajouté, retiré,
  //      ou dont le chemin de quota change, tue cette assertion.
  const declared = providerProducingOperations().map((operation) => NATIVE_OPERATION_SERVICE[operation]);
  assert.deepEqual(
    [...withQuotaAssertion].sort(),
    [...new Set(declared)].sort(),
    'dérive entre les chemins provider-producing réels et la table d’effets',
  );

  // 12 · et dans l'autre sens : aucun service déclaré local ne porte l'assertion.
  for (const operation of COCKPIT_OPERATION_IDS) {
    const effect = operationEffect(operation);
    if (effect.may_call_provider === 'YES') continue;
    const source = await executable(`services/${NATIVE_OPERATION_SERVICE[operation]}`);
    assert.equal(
      source.includes('assertInvocationQuotaAvailable'),
      false,
      `${operation} est déclaré sans appel fournisseur, son service ne doit pas engager de quota`,
    );
  }
});

test('13 · aucune autorité n’est rejouée, aucune entrée/sortie propre', async () => {
  const presentation = await executable('services/cockpit-presentation.ts');
  const effects = await executable('services/invocation-effect.ts');

  for (const source of [presentation, effects]) {
    // Pure : ni disque, ni horloge, ni réseau.
    for (const forbidden of ['readFile', 'writeFile', 'new Date', 'fetch', 'readStableNativeRunSnapshot']) {
      assert.equal(source.includes(forbidden), false, `la projection ignore ${forbidden}`);
    }
    // Ni quota, ni politique, ni journaux : elle ne décide d'aucune admission.
    for (const forbidden of [
      'invocation-policy',
      'invocation-quota',
      'assertInvocationQuotaAvailable(',
      'usage-ledger',
      'invocation-ledger',
    ]) {
      assert.equal(source.includes(forbidden), false, `la projection ignore ${forbidden}`);
    }
    // Aucune règle de capacité ni de reprise recopiée.
    for (const forbidden of ['reason_code', 'available_actions', 'RECOVERY_REQUIRED', 'read_model_version']) {
      assert.equal(source.includes(forbidden), false, `règle métier recopiée : ${forbidden}`);
    }
  }

  // Le tri est structurellement absent : l'ordre du journal fait autorité.
  assert.equal(presentation.includes('.sort('), false, 'aucun tri local');

  // La projection native reste ignorante de la présentation.
  const native = await executable('services/native-read-model.ts');
  for (const forbidden of ['cockpit-presentation', 'invocation-effect']) {
    assert.equal(native.includes(forbidden), false, `native-read-model ignore ${forbidden}`);
  }

  // Un seul instantané est lu par la vue HTTP native.
  const http = await executable('cockpit/native-read-http.ts');
  const runView = http.slice(
    http.indexOf('export async function readNativeRunHttpView'),
    http.indexOf('export async function readNativeRecoveryHttpView'),
  );
  assert.ok(runView.length > 0);
  assert.equal(runView.split('readStableNativeRunSnapshot').length - 1, 1, 'une seule lecture de snapshot');
});

// ==========================================================================
// D. Dernières contributions
// ==========================================================================

test('14–16 · dernière contribution par slot, par provenance et non par moteur', async () => {
  const dir = await makeTempDir('ccr-s1-contrib-');
  try {
    const f = await nativeRun(dir);
    // Un second tour de l'auteur : c'est le plus récent qui doit ressortir.
    const later = await f.events.append({
      round: 1,
      actor: 'expert',
      type: 'assistant_response',
      expert_slot_id: 'author',
      session_id: f.sessions.author,
      content: 'seconde position de author',
      exit_code: 0,
      timestamp: '2026-08-11T01:00:00.000Z',
    });

    const view = await readNativeRunHttpView({ runsDir: f.runsDir }, RUN_ID);
    const author = view.presentation.latest_contributions.author;
    const challenger = view.presentation.latest_contributions.challenger;
    assert.ok(author !== null && challenger !== null);

    // 14 · la dernière contribution de l'auteur est bien la seconde.
    assert.equal(author.event_id, later.event_id);
    assert.equal(author.round, 1);
    assert.equal(author.provider, 'codex', 'le fournisseur vient du manifest');
    assert.equal(author.session_id, f.sessions.author);
    assert.equal(author.content_bytes, Buffer.byteLength('seconde position de author', 'utf8'));

    // 15 · celle du challenger n'a pas bougé, et reste la sienne.
    assert.equal(challenger.round, 0);
    assert.equal(challenger.provider, 'claude');
    assert.equal(challenger.session_id, f.sessions.challenger);

    // 16 · une référence, pas une copie : aucun contenu intégral n'est dupliqué.
    assert.equal('content' in author, false, 'la contribution reste une référence');
  } finally {
    await removeTempDir(dir);
  }
});

test('17 · same-provider : deux slots distincts sous un moteur unique', async () => {
  const dir = await makeTempDir('ccr-s1-same-');
  try {
    const f = await nativeRun(dir, { bindings: { author: 'claude', challenger: 'claude' } });
    const view = await readNativeRunHttpView({ runsDir: f.runsDir }, RUN_ID);
    const author = view.presentation.latest_contributions.author;
    const challenger = view.presentation.latest_contributions.challenger;
    assert.ok(author !== null && challenger !== null);

    // Même fournisseur des deux côtés — et pourtant deux contributions
    // différentes : la sélection se fait par slot, jamais par moteur.
    assert.equal(author.provider, 'claude');
    assert.equal(challenger.provider, 'claude');
    assert.notEqual(author.event_id, challenger.event_id);
    assert.notEqual(author.session_id, challenger.session_id);
  } finally {
    await removeTempDir(dir);
  }
});

test('18 · un slot sans contribution rend null, jamais un substitut', async () => {
  const dir = await makeTempDir('ccr-s1-empty-');
  try {
    const f = await nativeRun(dir, { onlyAuthor: true });
    const view = await readNativeRunHttpView({ runsDir: f.runsDir }, RUN_ID);
    assert.ok(view.presentation.latest_contributions.author !== null);
    assert.equal(view.presentation.latest_contributions.challenger, null);
  } finally {
    await removeTempDir(dir);
  }
});

// ==========================================================================
// E. Contexte initial
// ==========================================================================

test('19–21 · contexte initial exact, divergence déclarée, absence dite', async () => {
  const dir = await makeTempDir('ccr-s1-context-');
  try {
    // 19 · deux prompts d'initialisation portant le même texte : disponible.
    const f = await nativeRun(dir);
    const view = await readNativeRunHttpView({ runsDir: f.runsDir }, RUN_ID);
    const context = view.presentation.initial_context;
    assert.equal(context.status, 'AVAILABLE');
    if (context.status !== 'AVAILABLE') throw new Error('AVAILABLE attendu');
    assert.equal(context.content, MISSION, 'le texte de l’humain, verbatim');
    assert.equal(context.event_ids.length, 2, 'un prompt par slot');

    // Un prompt de transfert (actor system) n'est jamais pris pour un contexte.
    await f.events.append({
      round: 1,
      actor: 'system',
      type: 'prompt_sent',
      target_expert_slot_id: 'challenger',
      session_id: f.sessions.challenger,
      content: 'ENVELOPPE DE TRANSFERT — ne doit jamais être lue comme le contexte',
      timestamp: '2026-08-11T02:00:00.000Z',
    });
    const after = await readNativeRunHttpView({ runsDir: f.runsDir }, RUN_ID);
    assert.equal(
      after.presentation.initial_context.status === 'AVAILABLE'
        ? after.presentation.initial_context.content
        : null,
      MISSION,
    );
    assert.equal(
      after.presentation.initial_context.status === 'AVAILABLE'
        ? after.presentation.initial_context.event_ids.length
        : -1,
      2,
      'l’enveloppe de transfert n’entre pas dans le contexte initial',
    );
  } finally {
    await removeTempDir(dir);
  }

  // 20 · deux prompts divergents : rien n'est choisi, la divergence est dite.
  const diverging = await makeTempDir('ccr-s1-divergent-');
  try {
    const f = await nativeRun(diverging, {
      prompts: { author: 'Texte A', challenger: 'Texte B' },
    });
    const view = await readNativeRunHttpView({ runsDir: f.runsDir }, RUN_ID);
    const context = view.presentation.initial_context;
    assert.equal(context.status, 'UNAVAILABLE');
    if (context.status !== 'UNAVAILABLE') throw new Error('UNAVAILABLE attendu');
    assert.equal(context.reason, 'INCONSISTENT');
    assert.equal(context.event_ids.length, 2, 'les deux faits divergents restent nommés');
    assert.equal(JSON.stringify(context).includes('Texte A'), false, 'aucun des deux n’est retenu');
    assert.equal(JSON.stringify(context).includes('Texte B'), false);
  } finally {
    await removeTempDir(diverging);
  }

  // 21 · aucun prompt humain : l'absence se dit, elle ne se fabrique pas.
  const bare = await makeTempDir('ccr-s1-nocontext-');
  try {
    const runsDir = path.join(bare, 'runs');
    const paths = runPaths(runsDir, RUN_ID);
    await mkdir(paths.roundsDir, { recursive: true });
    const manifest = manifestOf(
      { author: 'codex', challenger: 'claude' },
      { author: null, challenger: null },
    );
    await writeNativeManifest(paths, manifest);
    await writeNativeState(paths, stateOf());
    await openNativeEventStore(paths, manifest);

    const view = await readNativeRunHttpView({ runsDir }, RUN_ID);
    assert.deepEqual(view.presentation.initial_context, {
      status: 'UNAVAILABLE',
      reason: 'NOT_FOUND',
      event_ids: [],
    });
  } finally {
    await removeTempDir(bare);
  }
});

// ==========================================================================
// F. Périmètre du run existant
// ==========================================================================

test('22 · un run existant ne transporte pas l’effet START', async () => {
  const dir = await makeTempDir('ccr-s1-scope-');
  try {
    const f = await nativeRun(dir);
    const view = await readNativeRunHttpView({ runsDir: f.runsDir }, RUN_ID);
    const operations = view.presentation.actions.map((action) => action.operation);

    // Un run déjà né ne se démarre pas : l'y transporter préparerait un écran
    // qui n'existe pas encore, au prix d'un fait sans objet.
    assert.equal(operations.includes('START'), false);
    assert.deepEqual([...operations].sort(), ['HANDOFF', 'PAUSE', 'RESUME', 'SEND', 'STEP']);

    // L'effet reste néanmoins disponible dans la primitive partagée.
    assert.deepEqual(operationEffect('START').invocation_effect, { kind: 'AT_MOST', count: 2 });
  } finally {
    await removeTempDir(dir);
  }
});
