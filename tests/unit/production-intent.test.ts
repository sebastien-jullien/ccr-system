/**
 * P3 — intention de production d'un run natif.
 *
 * Question de preuve :
 *
 * > **CCR enregistre-t-il une déclaration procédurale humaine — et rien de
 * > plus — sans toucher au RunState, au contrôle, au quota, ni à une source
 * > transférable en attente, et sans qu'aucun fournisseur ne soit approché ?**
 *
 * Six propriétés.
 *
 *  1. **Autorité humaine.** Le fait est humain et porte sur le run. Aucune
 *     identité d'expert ne peut lui être attachée — la validation la refuse.
 *  2. **Deux transitions, deux idempotences.** Un geste déjà satisfait réussit
 *     sans écrire, et ne fabrique aucun historique pour loger une note.
 *  3. **Une frontière acquittée une fois.** Le premier fait P3 rend le journal
 *     illisible par une version antérieure ; l'acquittement porte l'identité
 *     exacte du run, et n'est exigé qu'à cette frontière.
 *  4. **Séparation stricte.** Ni RunState, ni contrôle, ni quota, ni transfert
 *     en attente ne bougent. `state.json` reste byte-identique.
 *  5. **Admission refusée avant le fournisseur.** Un pas est refusé par une
 *     décision pure ; rien n'est consommé, rien n'est écrit.
 *  6. **Aucun jugement.** Ni correction, ni complétude, ni accord, ni
 *     convergence, ni clôture ne se déduisent du fait ou de sa surface.
 *
 * Aucun fournisseur, aucun adapter, aucun processus : les dépendances du
 * service ne portent aucune fabrique d'adapter, et le planificateur est pur.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { isCcrError } from '../../src/core/errors.ts';
import type { CcrErrorCode } from '../../src/core/errors.ts';
import { validateNativeEventShape } from '../../src/core/event-provenance.ts';
import { provenanceShapeOf } from '../../src/core/event-provenance.ts';
import {
  DEFAULT_PRODUCTION_INTENT,
  PRODUCTION_INTENTS,
  deriveProductionIntent,
  hasProductionIntentFact,
} from '../../src/core/production-intent.ts';
import {
  NATIVE_MANIFEST_SCHEMA_VERSION,
  NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION,
  NATIVE_STATE_SCHEMA_VERSION,
  PRODUCTION_INTENT_EVENT_TYPES,
} from '../../src/core/run-native.ts';
import type {
  NativeCcrEvent,
  NativeRunManifest,
  NativeRunStateDocument,
} from '../../src/core/run-native.ts';
import { RUN_STATES } from '../../src/core/state.ts';
import type { RunState } from '../../src/core/state.ts';
import {
  endNativeProduction,
  reactivateNativeProduction,
} from '../../src/services/native-production-service.ts';
import type { NativeProductionDeps } from '../../src/services/native-production-service.ts';
import { planNativeStep } from '../../src/services/native-step-planner.ts';
import { readInvocationQuotaView } from '../../src/services/invocation-quota-read.ts';
import { runPaths } from '../../src/store/layout.ts';
import { openInvocationPolicyStore } from '../../src/store/invocation-policy-store.ts';
import { openNativeEventStore } from '../../src/store/native-event-store.ts';
import type { NativeEventStore } from '../../src/store/native-event-store.ts';
import {
  readPersistedState,
  writeNativeManifest,
  writeNativeState,
} from '../../src/store/native-store.ts';
import { runCli } from '../../src/cli/main.ts';
import type { CliIo } from '../../src/cli/main.ts';
import type { RunServiceDeps } from '../../src/services/run-service.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

const RUN_ID = 'CCR-20260907-001';
const AT = '2026-09-07T00:00:00.000Z';
const MISSION = 'Mission initiale : évaluer la refonte.';
const SESSIONS = { author: 'codex-1', challenger: 'claude-1' } as const;

// --------------------------------------------------------------------------
// Matérialisation
// --------------------------------------------------------------------------

function manifestOf(): NativeRunManifest {
  return {
    schema_version: NATIVE_MANIFEST_SCHEMA_VERSION,
    run_id: RUN_ID,
    title: 'Contre-expertise',
    created_at: AT,
    workspace: { cwd: 'E:/prog/exemple' },
    experts: {
      author: { provider: 'codex', session_id: SESSIONS.author },
      challenger: { provider: 'claude', session_id: SESSIONS.challenger },
    },
    runtime_config: {
      schema_version: NATIVE_RUNTIME_CONFIG_SCHEMA_VERSION,
      captured_at: AT,
      claude: {
        required: true,
        probe_status: 'OBSERVED',
        cli_version: '2.1.224',
        auth_preflight: 'AUTHENTICATED',
      },
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

interface Fixture {
  readonly runsDir: string;
  readonly paths: ReturnType<typeof runPaths>;
  readonly manifest: NativeRunManifest;
  /** Dernière réponse de l'AUTHOR : la source du premier transfert. */
  readonly authorResponse: string;
}

/** START d'un slot, tel que `initializeNativeSlot` l'écrit. */
async function startSlot(events: NativeEventStore, slot: 'author' | 'challenger', session: string): Promise<string> {
  const prompt = await events.append({
    round: 0,
    actor: 'human',
    type: 'prompt_sent',
    target_expert_slot_id: slot,
    content: MISSION,
    timestamp: AT,
  });
  const response = await events.append({
    round: 0,
    actor: 'expert',
    type: 'assistant_response',
    expert_slot_id: slot,
    session_id: session,
    content: `position initiale de ${slot}`,
    exit_code: 0,
    based_on: [prompt.event_id],
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
  return response.event_id;
}

/** Run natif complet, prêt à transférer — l'état de sortie de START. */
async function readyRun(dir: string, over: Partial<NativeRunStateDocument> = {}): Promise<Fixture> {
  const runsDir = path.join(dir, 'runs');
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.roundsDir, { recursive: true });
  const manifest = manifestOf();
  await writeNativeManifest(paths, manifest);
  await writeNativeState(paths, stateOf(over));
  const events = await openNativeEventStore(paths, manifest);
  const authorResponse = await startSlot(events, 'author', SESSIONS.author);
  await startSlot(events, 'challenger', SESSIONS.challenger);
  return { runsDir, paths, manifest, authorResponse };
}

function deps(runsDir: string): NativeProductionDeps {
  return { runsDir, now: () => new Date(AT) };
}

async function journal(fixture: Fixture): Promise<readonly NativeCcrEvent[]> {
  return (await openNativeEventStore(fixture.paths, fixture.manifest)).readAll();
}

async function currentState(fixture: Fixture): Promise<NativeRunStateDocument> {
  const persisted = await readPersistedState(fixture.paths);
  if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') throw new Error('état natif attendu');
  return persisted.document;
}

function countOf(events: readonly NativeCcrEvent[], type: string): number {
  return events.filter((event) => event.type === type).length;
}

interface Captured {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function cli(runsDir: string, argv: readonly string[]): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { out: (line) => out.push(line), err: (line) => err.push(line) };
  const cliDeps = { runsDir, now: () => new Date(AT) } as RunServiceDeps;
  const code = await runCli([...argv, '--runs-dir', runsDir], { io, deps: cliDeps });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

async function expectRejection(promise: Promise<unknown>, code: CcrErrorCode, what: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => isCcrError(error) && error.code === code, what);
}

/** Empreinte exacte de `state.json` : contenu et date de dernière écriture. */
async function stateFingerprint(fixture: Fixture): Promise<{ bytes: string; mtimeMs: number }> {
  return {
    bytes: await readFile(fixture.paths.state, 'utf8'),
    mtimeMs: (await stat(fixture.paths.state)).mtimeMs,
  };
}

// --------------------------------------------------------------------------
// 1 · Autorité humaine, et un fait qui porte sur le run
// --------------------------------------------------------------------------

test("P1 · le fait est humain, sans identité d'expert, et n'en accepte aucune", async (t) => {
  const dir = await makeTempDir('ccr-p3-authority-');
  t.after(() => removeTempDir(dir));
  const fixture = await readyRun(dir);

  await endNativeProduction(deps(fixture.runsDir), RUN_ID, { note: 'fin de campagne', acknowledgeDowngrade: RUN_ID });

  const written = (await journal(fixture)).find((event) => event.type === 'production_ended');
  assert.ok(written !== undefined, 'le fait durable existe');
  assert.equal(written.actor, 'human', "l'acteur est humain : ni expert, ni système");

  // La classe de provenance est propre, et sans champ de slot.
  assert.equal(provenanceShapeOf('production_ended'), 'PRODUCTION_INTENT');
  for (const field of ['expert_slot_id', 'target_expert_slot_id', 'source_slot_id', 'target_slot_id']) {
    assert.ok(!(field in (written as unknown as Record<string, unknown>)), `${field} absent du fait écrit`);
  }

  // ROLE ≠ AUTORITÉ : un fait qui prétendrait qu'un expert a déclaré la fin de
  // production est refusé à l'écriture comme à la relecture.
  for (const field of ['expert_slot_id', 'target_expert_slot_id', 'source_slot_id']) {
    assert.throws(
      () =>
        validateNativeEventShape(
          {
            event_id: 'evt_0000000099',
            run_id: RUN_ID,
            round: 0,
            timestamp: AT,
            actor: 'human',
            type: 'production_ended',
            [field]: 'author',
          },
          null,
        ),
      (error: unknown) => isCcrError(error) && error.code === 'JOURNAL_INVALID',
      `${field} refusé sur un fait d'intention`,
    );
  }
});

test("P1b · un fait d'intention ne nomme ni session, ni opération close, ni motif", () => {
  const base = {
    event_id: 'evt_0000000099',
    run_id: RUN_ID,
    round: 0,
    timestamp: AT,
    actor: 'human' as const,
    type: 'production_reactivated' as const,
  };
  assert.ok(validateNativeEventShape({ ...base }, null), 'la forme minimale est valide');

  for (const field of ['session_id', 'prompt_event_id', 'started_event_id', 'source_event_id', 'response_event_id', 'reason']) {
    assert.throws(
      () => validateNativeEventShape({ ...base, [field]: 'x' }, null),
      (error: unknown) => isCcrError(error) && error.code === 'JOURNAL_INVALID',
      `${field} refusé`,
    );
  }
});

test("P1c · les types P3 sont propres au natif : un journal historique les refuse", async (t) => {
  const dir = await makeTempDir('ccr-p3-legacy-');
  t.after(() => removeTempDir(dir));

  // La garde de génération est appliquée avant toute écriture, par le module
  // partagé des deux stores.
  const { assertNoNativeProvenance } = await import('../../src/core/event-provenance.ts');
  for (const type of PRODUCTION_INTENT_EVENT_TYPES) {
    assert.throws(
      () => assertNoNativeProvenance({ actor: 'human', type }),
      (error: unknown) => isCcrError(error) && error.code === 'JOURNAL_INVALID',
      `${type} refusé dans un journal historique`,
    );
  }
});

// --------------------------------------------------------------------------
// 2 · Dérivation, transitions et idempotence
// --------------------------------------------------------------------------

test('P6 · sans aucun fait P3, l’intention est STEPS_INTENDED', async (t) => {
  const dir = await makeTempDir('ccr-p3-default-');
  t.after(() => removeTempDir(dir));
  const fixture = await readyRun(dir);

  assert.deepEqual([...PRODUCTION_INTENTS], ['STEPS_INTENDED', 'NO_STEPS_INTENDED']);
  assert.equal(DEFAULT_PRODUCTION_INTENT, 'STEPS_INTENDED');
  assert.equal(deriveProductionIntent([]), 'STEPS_INTENDED', 'un journal vide ne déclare rien');
  assert.equal(deriveProductionIntent(await journal(fixture)), 'STEPS_INTENDED');
  assert.equal(hasProductionIntentFact(await journal(fixture)), false);
});

test('P2 · END effectif : exactement un fait durable, et l’intention bascule', async (t) => {
  const dir = await makeTempDir('ccr-p3-end-');
  t.after(() => removeTempDir(dir));
  const fixture = await readyRun(dir);

  const result = await endNativeProduction(deps(fixture.runsDir), RUN_ID, {
    note: 'campagne suspendue par décision humaine',
    acknowledgeDowngrade: RUN_ID,
  });

  assert.equal(result.changed, true);
  assert.equal(result.intent, 'NO_STEPS_INTENDED');
  assert.ok(result.eventId !== null);

  const events = await journal(fixture);
  assert.equal(countOf(events, 'production_ended'), 1, 'exactement un fait');
  assert.equal(deriveProductionIntent(events), 'NO_STEPS_INTENDED');
  assert.equal(hasProductionIntentFact(events), true);
});

test('P3 · REACTIVATION effective : exactement un fait durable, sans effacer le précédent', async (t) => {
  const dir = await makeTempDir('ccr-p3-reactivate-');
  t.after(() => removeTempDir(dir));
  const fixture = await readyRun(dir);
  const service = deps(fixture.runsDir);

  await endNativeProduction(service, RUN_ID, { note: 'pause', acknowledgeDowngrade: RUN_ID });
  const result = await reactivateNativeProduction(service, RUN_ID, { note: 'reprise' });

  assert.equal(result.changed, true);
  assert.equal(result.intent, 'STEPS_INTENDED');

  const events = await journal(fixture);
  assert.equal(countOf(events, 'production_reactivated'), 1);
  // L'histoire reste entière : le fait de fin survit à sa réactivation.
  assert.equal(countOf(events, 'production_ended'), 1, 'le fait de fin est conservé');
  assert.equal(deriveProductionIntent(events), 'STEPS_INTENDED');
});

test('P4 · END idempotent : le second geste réussit sans écrire', async (t) => {
  const dir = await makeTempDir('ccr-p3-end-idem-');
  t.after(() => removeTempDir(dir));
  const fixture = await readyRun(dir);
  const service = deps(fixture.runsDir);

  await endNativeProduction(service, RUN_ID, { note: 'première', acknowledgeDowngrade: RUN_ID });
  const before = await readFile(fixture.paths.events, 'utf8');

  const again = await endNativeProduction(service, RUN_ID, { note: 'seconde note, jamais persistée' });

  assert.equal(again.changed, false, 'idempotence : aucun changement');
  assert.equal(again.eventId, null, 'aucun fait produit');
  assert.equal(again.intent, 'NO_STEPS_INTENDED');
  assert.equal(await readFile(fixture.paths.events, 'utf8'), before, 'journal byte-identique');
  assert.equal(countOf(await journal(fixture), 'production_ended'), 1);
  assert.ok(!before.includes('seconde note'), 'la note du NOOP est absente du journal');
});

test('P5 · REACTIVATION idempotente, y compris sans aucun fait P3 historique', async (t) => {
  const dir = await makeTempDir('ccr-p3-react-idem-');
  t.after(() => removeTempDir(dir));
  const fixture = await readyRun(dir);
  const service = deps(fixture.runsDir);

  const before = await readFile(fixture.paths.events, 'utf8');
  const noop = await reactivateNativeProduction(service, RUN_ID, { note: 'jamais persistée' });

  assert.equal(noop.changed, false, 'déjà satisfaite : aucun changement');
  assert.equal(noop.eventId, null);
  assert.equal(noop.intent, 'STEPS_INTENDED');
  assert.equal(await readFile(fixture.paths.events, 'utf8'), before, 'journal byte-identique');
  assert.equal(hasProductionIntentFact(await journal(fixture)), false, 'aucun historique fabriqué');

  await endNativeProduction(service, RUN_ID, { note: 'fin', acknowledgeDowngrade: RUN_ID });
  await reactivateNativeProduction(service, RUN_ID);
  const settled = await readFile(fixture.paths.events, 'utf8');
  const secondNoop = await reactivateNativeProduction(service, RUN_ID);
  assert.equal(secondNoop.changed, false);
  assert.equal(await readFile(fixture.paths.events, 'utf8'), settled);
});

test('P13–P14 · la note est durable, verbatim, et sémantiquement opaque', async (t) => {
  const dir = await makeTempDir('ccr-p3-note-');
  t.after(() => removeTempDir(dir));
  const fixture = await readyRun(dir);

  const note = 'Le challenger a raison, le candidat est correct et complet.\n  Ligne 2  ';
  await endNativeProduction(deps(fixture.runsDir), RUN_ID, { note, acknowledgeDowngrade: RUN_ID });

  const written = (await journal(fixture)).find((event) => event.type === 'production_ended');
  assert.equal(written?.content, note, 'conservée verbatim, espaces et retour de ligne compris');

  assert.equal(deriveProductionIntent(await journal(fixture)), 'NO_STEPS_INTENDED');
});

test('P12 · la note est facultative sur la réactivation, et son absence n_ecrit aucun champ vide', async (t) => {
  const dir = await makeTempDir('ccr-p3-note-optional-');
  t.after(() => removeTempDir(dir));
  const fixture = await readyRun(dir);
  const service = deps(fixture.runsDir);

  await endNativeProduction(service, RUN_ID, { note: 'fin', acknowledgeDowngrade: RUN_ID });
  await reactivateNativeProduction(service, RUN_ID);

  const written = (await journal(fixture)).find((event) => event.type === 'production_reactivated');
  assert.ok(written !== undefined);
  assert.ok(
    !('content' in (written as unknown as Record<string, unknown>)),
    'aucune note : la cle est absente, jamais presente et vide',
  );
});

// --------------------------------------------------------------------------
// 3 · Frontière de compatibilité descendante
// --------------------------------------------------------------------------

test('P7–P8 · le premier fait P3 exige un acquittement ; absent, rien n_est ecrit', async (t) => {
  const dir = await makeTempDir('ccr-p3-ack-');
  t.after(() => removeTempDir(dir));
  const fixture = await readyRun(dir);

  const eventsBefore = await readFile(fixture.paths.events, 'utf8');
  const stateBefore = await stateFingerprint(fixture);

  await expectRejection(
    endNativeProduction(deps(fixture.runsDir), RUN_ID, { note: 'fin' }),
    'DOWNGRADE_ACKNOWLEDGEMENT_REQUIRED',
    'acquittement exige au premier fait',
  );

  assert.equal(await readFile(fixture.paths.events, 'utf8'), eventsBefore, 'journal inchange');
  assert.deepEqual(await stateFingerprint(fixture), stateBefore, 'state.json inchange');
  assert.equal(hasProductionIntentFact(await journal(fixture)), false, 'aucun fait P3 ecrit');
});

test('P8b · en CLI, un acquittement manquant sort en 2 et divulgue la frontiere', async (t) => {
  const dir = await makeTempDir('ccr-p3-ack-cli-');
  t.after(() => removeTempDir(dir));
  const fixture = await readyRun(dir);

  const result = await cli(fixture.runsDir, ['end-production', '--run', RUN_ID, '--note', 'fin']);

  assert.equal(result.code, 2, 'invocation a reformer, non erreur de traitement');
  assert.match(result.err, /version anterieure|antérieure/i, 'la frontiere est nommee');
  assert.match(result.err, /--acknowledge-downgrade/, 'invocation a reformer donnee');
  assert.ok(result.err.includes(RUN_ID), 'identite exacte du run donnee');
  assert.equal(hasProductionIntentFact(await journal(fixture)), false);
});

test('P9 · un acquittement designant un autre run est refuse, a tout instant', async (t) => {
  const dir = await makeTempDir('ccr-p3-ack-mismatch-');
  t.after(() => removeTempDir(dir));
  const fixture = await readyRun(dir);
  const OTHER = 'CCR-20260101-999';

  const before = await cli(fixture.runsDir, [
    'end-production', '--run', RUN_ID, '--note', 'fin', '--acknowledge-downgrade', OTHER,
  ]);
  assert.equal(before.code, 2);
  assert.equal(hasProductionIntentFact(await journal(fixture)), false, 'aucun fait ecrit');

  await endNativeProduction(deps(fixture.runsDir), RUN_ID, { note: 'fin', acknowledgeDowngrade: RUN_ID });
  const settled = await readFile(fixture.paths.events, 'utf8');

  // Apres la frontiere : la mauvaise valeur n'est toujours pas ignoree.
  const after = await cli(fixture.runsDir, [
    'end-production', '--run', RUN_ID, '--note', 'encore', '--acknowledge-downgrade', OTHER,
  ]);
  assert.equal(after.code, 2);
  assert.equal(await readFile(fixture.paths.events, 'utf8'), settled, 'journal inchange');

  // Sur une reprise idempotente : meme regle. L'intention est deja celle
  // demandee, et pourtant l'usage est juge avant toute idempotence.
  const idempotent = await cli(fixture.runsDir, [
    'end-production', '--run', RUN_ID, '--note', 'encore', '--acknowledge-downgrade', OTHER,
  ]);
  assert.equal(idempotent.code, 2);
  assert.equal(await readFile(fixture.paths.events, 'utf8'), settled, 'journal inchange');
});

/**
 * P9b · l'acquittement de descente n'existe pas sur `reactivate-production`.
 *
 * Une reactivation ne peut pas etre le premier fait P3 d'un run : elle n'est
 * effective que si l'intention courante vaut deja NO_STEPS_INTENDED, ce qui
 * exige un `production_ended` anterieur. La frontiere de compatibilite est donc
 * toujours deja franchie, et un acquittement n'y aurait rien a acquitter.
 *
 * Ce test exige que **l'option elle-meme** soit refusee. Un `exit 2` obtenu
 * pour une autre raison ne prouverait rien : c'est la raison qui est le contrat.
 */
test('P9b · --acknowledge-downgrade est refuse en tant qu_option sur reactivate-production', async (t) => {
  const dir = await makeTempDir('ccr-p3-react-noack-');
  t.after(() => removeTempDir(dir));
  const fixture = await readyRun(dir);
  const service = deps(fixture.runsDir);

  // Un run reellement reactivable : la frontiere est franchie, et une
  // reactivation nue reussirait.
  await endNativeProduction(service, RUN_ID, { note: 'fin', acknowledgeDowngrade: RUN_ID });
  const settled = await readFile(fixture.paths.events, 'utf8');

  // Valeur exacte du run, donc valide au sens de l'ancienne regle : seul le
  // fait que l'option n'existe pas peut expliquer le refus.
  const correct = await cli(fixture.runsDir, [
    'reactivate-production', '--run', RUN_ID, '--acknowledge-downgrade', RUN_ID,
  ]);
  assert.equal(correct.code, 2, 'usage incorrect');
  assert.match(
    correct.err,
    /Option inconnue : --acknowledge-downgrade/,
    "c'est l'option elle-meme qui est refusee, pas sa valeur",
  );
  assert.equal(await readFile(fixture.paths.events, 'utf8'), settled, 'aucun write P3');

  // Meme refus avec une valeur quelconque : le parseur tranche avant tout sens.
  const other = await cli(fixture.runsDir, [
    'reactivate-production', '--run', RUN_ID, '--acknowledge-downgrade', 'CCR-20260101-999',
  ]);
  assert.equal(other.code, 2);
  assert.match(other.err, /Option inconnue : --acknowledge-downgrade/);
  assert.equal(await readFile(fixture.paths.events, 'utf8'), settled, 'aucun write P3');

  // Et la reactivation nue, elle, fonctionne : le retrait n'a pas casse la commande.
  const bare = await cli(fixture.runsDir, ['reactivate-production', '--run', RUN_ID]);
  assert.equal(bare.code, 0);
  assert.equal(deriveProductionIntent(await journal(fixture)), 'STEPS_INTENDED');
});

test('P10 · apres la frontiere, un acquittement correct est accepte et inerte', async (t) => {
  const dir = await makeTempDir('ccr-p3-ack-inert-');
  t.after(() => removeTempDir(dir));
  const fixture = await readyRun(dir);
  const service = deps(fixture.runsDir);

  await endNativeProduction(service, RUN_ID, { note: 'fin', acknowledgeDowngrade: RUN_ID });

  const withoutAck = await reactivateNativeProduction(service, RUN_ID);
  assert.equal(withoutAck.changed, true, 'frontiere franchie : plus rien a acquitter');

  await endNativeProduction(service, RUN_ID, { note: 'de nouveau', acknowledgeDowngrade: RUN_ID });
  const settled = await readFile(fixture.paths.events, 'utf8');
  const inert = await endNativeProduction(service, RUN_ID, {
    note: 'reprise apres reponse perdue',
    acknowledgeDowngrade: RUN_ID,
  });

  assert.equal(inert.changed, false, 'le retry ne redouble pas le fait');
  assert.equal(await readFile(fixture.paths.events, 'utf8'), settled, 'aucune ecriture propre');
});

test('P11 · note obligatoire sur end-production, facultative sur reactivate-production', async (t) => {
  const dir = await makeTempDir('ccr-p3-note-required-');
  t.after(() => removeTempDir(dir));
  const fixture = await readyRun(dir);

  const missing = await cli(fixture.runsDir, [
    'end-production', '--run', RUN_ID, '--acknowledge-downgrade', RUN_ID,
  ]);
  assert.equal(missing.code, 2, 'usage incorrect');
  assert.match(missing.err, /--note/, 'option manquante nommee');
  assert.equal(hasProductionIntentFact(await journal(fixture)), false, 'aucun fait ecrit');

  const ok = await cli(fixture.runsDir, [
    'end-production', '--run', RUN_ID, '--note', 'fin', '--acknowledge-downgrade', RUN_ID,
  ]);
  assert.equal(ok.code, 0);

  const reactivate = await cli(fixture.runsDir, ['reactivate-production', '--run', RUN_ID]);
  assert.equal(reactivate.code, 0, 'aucune note exigee sur la reactivation');
});

// --------------------------------------------------------------------------
// 4 · Separations strictes : RunState, controle, quota, transfert
// --------------------------------------------------------------------------

test('P15–P17 · P3 ne touche ni le RunState ni le controle, et state.json reste intact', async (t) => {
  const dir = await makeTempDir('ccr-p3-state-');
  t.after(() => removeTempDir(dir));
  const fixture = await readyRun(dir);
  const service = deps(fixture.runsDir);

  const before = await currentState(fixture);
  const fingerprint = await stateFingerprint(fixture);

  await endNativeProduction(service, RUN_ID, { note: 'fin', acknowledgeDowngrade: RUN_ID });
  await reactivateNativeProduction(service, RUN_ID, { note: 'reprise' });
  await endNativeProduction(service, RUN_ID, { note: 'de nouveau' });

  const after = await currentState(fixture);
  assert.deepEqual(after, before, 'document d_etat identique');
  assert.equal(after.state, 'READY', 'ni PAUSED, ni CLOSED');
  assert.equal(after.control, 'AUTOMATION', 'le proprietaire du controle est inchange');
  assert.equal(after.round, before.round, 'aucun round consomme');
  assert.equal(after.next_step_source_slot, before.next_step_source_slot, 'curseur inchange');
  assert.deepEqual(await stateFingerprint(fixture), fingerprint, 'state.json jamais reecrit');

  // CONVERGED reste absent de la machine d_etat : P3 ne le reintroduit pas.
  assert.ok(!(RUN_STATES as readonly string[]).includes('CONVERGED'));
  const states: readonly RunState[] = RUN_STATES;
  assert.ok(states.includes('CLOSED'), 'CLOSED existe, et P3 ne le produit pas');
});

test('P16 · un run ferme par P3 ne devient pas CLOSED, et reste lisible comme avant', async (t) => {
  const dir = await makeTempDir('ccr-p3-not-closed-');
  t.after(() => removeTempDir(dir));
  const fixture = await readyRun(dir, { state: 'PAUSED', control: 'HUMAN' });
  await endNativeProduction(deps(fixture.runsDir), RUN_ID, { note: 'fin', acknowledgeDowngrade: RUN_ID });

  const after = await currentState(fixture);
  assert.equal(after.state, 'PAUSED', 'un run suspendu reste suspendu');
  assert.equal(after.control, 'HUMAN');
});

test('P19–P21 · le quota est intact, et son epuisement ne vaut pas une fin de production', async (t) => {
  const dir = await makeTempDir('ccr-p3-quota-');
  t.after(() => removeTempDir(dir));
  const fixture = await readyRun(dir);
  const service = deps(fixture.runsDir);

  await openInvocationPolicyStore(fixture.paths).create(3);
  const before = await readInvocationQuotaView(fixture.paths);
  const policyBytes = await readFile(fixture.paths.invocationPolicy, 'utf8');

  await endNativeProduction(service, RUN_ID, { note: 'fin', acknowledgeDowngrade: RUN_ID });
  const afterEnd = await readInvocationQuotaView(fixture.paths);
  await reactivateNativeProduction(service, RUN_ID);
  const afterReactivate = await readInvocationQuotaView(fixture.paths);

  assert.deepEqual(afterEnd, before, 'END ne touche pas le quota');
  assert.deepEqual(afterReactivate, before, 'REACTIVATION non plus');
  assert.equal(await readFile(fixture.paths.invocationPolicy, 'utf8'), policyBytes, 'politique intacte');

  // Epuisement du quota ≠ fin de production : un run dont la politique est
  // saturee ne porte aucun fait P3 de ce seul fait.
  const saturated = await readyRun(await makeTempDir('ccr-p3-quota-zero-'));
  await openInvocationPolicyStore(saturated.paths).create(0);
  const view = await readInvocationQuotaView(saturated.paths);
  assert.equal(view.kind === 'CONFIGURED' && view.exhausted, true, 'politique saturee');
  assert.equal(deriveProductionIntent(await journal(saturated)), 'STEPS_INTENDED');
  assert.equal(hasProductionIntentFact(await journal(saturated)), false);
});

// --------------------------------------------------------------------------
// 5 · Admission d_un pas natif
// --------------------------------------------------------------------------

test('P18–P24 · un pas est refuse avant le fournisseur, sans consommer la source', async (t) => {
  const dir = await makeTempDir('ccr-p3-step-');
  t.after(() => removeTempDir(dir));
  const fixture = await readyRun(dir);

  // Avant P3, le transfert est planifiable : la source existe et est prete.
  const manifest = fixture.manifest;
  const ready = planNativeStep({
    runId: RUN_ID,
    manifest,
    state: await currentState(fixture),
    events: await journal(fixture),
  });
  assert.equal(ready.kind, 'READY', 'une source transferable existe bien');

  await endNativeProduction(deps(fixture.runsDir), RUN_ID, { note: 'fin', acknowledgeDowngrade: RUN_ID });
  const journalAfterEnd = await readFile(fixture.paths.events, 'utf8');

  const refused = planNativeStep({
    runId: RUN_ID,
    manifest,
    state: await currentState(fixture),
    events: await journal(fixture),
  });

  assert.equal(refused.kind, 'REFUSED');
  assert.equal(
    refused.kind === 'REFUSED' ? refused.reason : null,
    'NO_FURTHER_PRODUCTION_STEPS_INTENDED',
    'le refus nomme la declaration humaine, et rien d_autre',
  );
  // Le refus rapporte une declaration humaine, et le detail structure ne porte
  // que cela : aucun verdict, aucune identite d_expert, aucun compte.
  const details = refused.kind === 'REFUSED' ? refused.error.details : {};
  assert.deepEqual(
    Object.keys(details).sort(),
    ['production_intent', 'runId'],
    'le detail du refus ne porte que le run et son intention',
  );
  assert.equal(details['production_intent'], 'NO_STEPS_INTENDED');

  // La source reste exactement ou elle etait : ni consommee, ni quarantainee,
  // ni supplantee. Le journal n_a pas bouge du fait du refus.
  assert.equal(await readFile(fixture.paths.events, 'utf8'), journalAfterEnd, 'aucun fait ecrit par le refus');
  const events = await journal(fixture);
  assert.equal(countOf(events, 'round_completed'), 0, 'aucun round abouti');
  assert.equal(countOf(events, 'transfer_uncertainty_acknowledged'), 0, 'aucune quarantaine');
  assert.equal(countOf(events, 'round_started'), 0, 'aucune tentative ouverte');

  // Et la source redevient transferable des la reactivation : elle avait bien
  // survecu intacte a la declaration.
  await reactivateNativeProduction(deps(fixture.runsDir), RUN_ID);
  const again = planNativeStep({
    runId: RUN_ID,
    manifest,
    state: await currentState(fixture),
    events: await journal(fixture),
  });
  assert.equal(again.kind, 'READY', 'la source etait preservee');
  assert.equal(again.kind === 'READY' ? again.sourceEventId : null, fixture.authorResponse);
});

test('P23 · le service P3 ne peut structurellement invoquer aucun fournisseur', async () => {
  // Preuve au niveau du type ET du module : les dependances n_exposent aucune
  // fabrique d_adapter, et le module n_importe aucun adaptateur.
  const source = await readFile(
    new URL('../../src/services/native-production-service.ts', import.meta.url),
    'utf8',
  );
  assert.ok(!source.includes('createAdapters'), 'aucune fabrique d_adapter');
  assert.ok(!source.includes('adapters/'), 'aucun adaptateur importe');
  assert.ok(!source.includes('invocation-ledger'), 'aucun engagement d_invocation');
  assert.ok(!source.includes('invocation-quota'), 'aucune consultation de quota');
});

test('P25 · STEPS_INTENDED ne court-circuite aucune autre garde', async (t) => {
  const dir = await makeTempDir('ccr-p3-not-bypass-');
  t.after(() => removeTempDir(dir));
  const fixture = await readyRun(dir, { control: 'HUMAN' });
  const service = deps(fixture.runsDir);

  // Aucun fait P3 : l_intention est STEPS_INTENDED, et pourtant la garde de
  // controle refuse toujours.
  const humanControlled = planNativeStep({
    runId: RUN_ID,
    manifest: fixture.manifest,
    state: await currentState(fixture),
    events: await journal(fixture),
  });
  assert.equal(humanControlled.kind, 'REFUSED');
  assert.equal(
    humanControlled.kind === 'REFUSED' ? humanControlled.reason : null,
    'AUTOMATION_NOT_IN_CONTROL',
    'la garde de controle garde sa precedence',
  );

  // Et une reactivation explicite ne la leve pas davantage.
  await endNativeProduction(service, RUN_ID, { note: 'fin', acknowledgeDowngrade: RUN_ID });
  await reactivateNativeProduction(service, RUN_ID);
  const stillRefused = planNativeStep({
    runId: RUN_ID,
    manifest: fixture.manifest,
    state: await currentState(fixture),
    events: await journal(fixture),
  });
  assert.equal(
    stillRefused.kind === 'REFUSED' ? stillRefused.reason : null,
    'AUTOMATION_NOT_IN_CONTROL',
    'reactiver ne rend aucun pas admissible par soi-meme',
  );
});

// --------------------------------------------------------------------------
// 6 · Semantiques negatives
// --------------------------------------------------------------------------

test('P38 · aucun nom, aucun vocabulaire et aucun etat ne permet de conclure un verdict', async (t) => {
  const dir = await makeTempDir('ccr-p3-negative-');
  t.after(() => removeTempDir(dir));
  const fixture = await readyRun(dir);

  await endNativeProduction(deps(fixture.runsDir), RUN_ID, { note: 'fin', acknowledgeDowngrade: RUN_ID });

  // 1. Le vocabulaire public est ferme, et ne contient aucun jeton de verdict.
  assert.deepEqual([...PRODUCTION_INTENTS], ['STEPS_INTENDED', 'NO_STEPS_INTENDED']);

  // 2. Aucun etat de run nouveau, et CONVERGED reste absent.
  assert.ok(!(RUN_STATES as readonly string[]).includes('CONVERGED'));
  assert.equal((await currentState(fixture)).state, 'READY', 'ni CLOSED, ni PAUSED');

  // 3. Le fait durable ne porte aucun champ de verdict, de compte ou d_identite.
  const written = (await journal(fixture)).find((event) => event.type === 'production_ended');
  const keys = Object.keys(written as unknown as Record<string, unknown>).sort();
  assert.deepEqual(
    keys,
    ['actor', 'content', 'event_id', 'round', 'run_id', 'timestamp', 'type'],
    'le fait durable ne porte rien de plus que son identite, son acteur et sa note',
  );

  // 4. Une source transferable existe toujours : « fin de production » ne dit
  //    pas « plus rien a transferer ».
  const events = await journal(fixture);
  const transferable = events.filter(
    (event) => event.type === 'assistant_response' && typeof event.content === 'string',
  );
  assert.ok(transferable.length > 0, 'des reponses transferables subsistent');

  // 5. Le quota n_est pas epuise pour autant.
  const quota = await readInvocationQuotaView(fixture.paths);
  assert.equal(quota.kind, 'NONE', 'aucune politique : rien n_est epuise');
});

test('P38b · P3 ne cree ni controverse resolue, ni decision, ni round abouti', async (t) => {
  const dir = await makeTempDir('ccr-p3-negative-2-');
  t.after(() => removeTempDir(dir));
  const fixture = await readyRun(dir);
  const service = deps(fixture.runsDir);

  await endNativeProduction(service, RUN_ID, { note: 'fin', acknowledgeDowngrade: RUN_ID });
  await reactivateNativeProduction(service, RUN_ID);
  await endNativeProduction(service, RUN_ID, { note: 'de nouveau' });

  const events = await journal(fixture);
  for (const type of ['decision_recorded', 'run_completed', 'round_completed', 'run_paused', 'run_resumed', 'control_changed', 'state_changed']) {
    assert.equal(countOf(events, type), 0, `aucun ${type} produit par P3`);
  }
});
