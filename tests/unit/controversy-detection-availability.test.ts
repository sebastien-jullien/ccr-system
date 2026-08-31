/**
 * V3-S7-C — frontière de disponibilité et voie d'acceptation contrôlée.
 *
 * Question de preuve :
 *
 * > **La capacité technique peut-elle exister sans être publiquement
 * > disponible, et le micro-gate REAL peut-il l'éprouver sans contourner la
 * > gouvernance ?**
 *
 * Quatre propriétés.
 *
 *  1. **Trois faits indépendants.** Implémenté, disponible et validé en réel
 *     ne se déduisent jamais l'un de l'autre.
 *  2. **Une porte fermée ne coûte rien.** Un refus public n'engage aucune
 *     invocation, ne consomme aucun quota, n'approche aucun adaptateur.
 *  3. **Deux autorisations, un seul pipeline.** La voie publique et la voie
 *     d'acceptation convergent vers le même service gouverné.
 *  4. **Rien n'est validé.** Aucun fournisseur réel n'a été approché, et
 *     aucun marqueur de validation n'existe.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { isCcrError } from '../../src/core/errors.ts';
import type { AgentAdapter, AgentTurnResult } from '../../src/adapters/agent-adapter.ts';
import { runPaths } from '../../src/store/layout.ts';
import type { RunPaths } from '../../src/store/layout.ts';
import { openInvocationLedger } from '../../src/store/invocation-ledger.ts';
import { openInvocationPolicyStore } from '../../src/store/invocation-policy-store.ts';
import { readControversyJournal } from '../../src/store/controversy-store.ts';
import {
  CONTROVERSY_DETECTOR_OUTPUT_VERSION,
  MODEL_DETECTION_IMPLEMENTED,
  MODEL_DETECTION_RUNTIME_AVAILABILITY,
  detectControversyRelations,
  requestModelDetection,
  runControlledAcceptanceDetection,
} from '../../src/services/controversy-detector.ts';
import type {
  ControlledAcceptanceAuthorization,
  DetectionDeps,
} from '../../src/services/controversy-detector.ts';
import { recordAssertion, recordControversy } from '../../src/services/controversy-service.ts';
import type { ControversyServiceDeps } from '../../src/services/controversy-service.ts';

const RUN_ID = 'CCR-20260818-001';
const SRC = new URL('../../src/', import.meta.url);

/**
 * Ce qui trahirait une **surface de détection assistée V3** — les symboles
 * réellement exportés par `services/controversy-detector.ts`, plus le chemin du
 * module et le jeton de sa voie d'acceptation contrôlée.
 *
 * Aucune chaîne générique : `detect`, `Detect` et `DETECTION` appartiennent
 * aussi aux détections structurelles `D01`–`D08` de V5, contractées et rendues
 * dans le cockpit. Interdire le mot interdirait un vocabulaire, pas une capacité.
 */
const V3_DETECTION_FORBIDDEN_SYMBOLS: readonly string[] = [
  'requestModelDetection',
  'detectControversyRelations',
  'runControlledAcceptanceDetection',
  'recordDetectedRelations',
  'parseDetectorOutput',
  'buildDetectionPrompt',
  'MODEL_DETECTION_RUNTIME_AVAILABILITY',
  'MODEL_DETECTION_IMPLEMENTED',
  'CONTROVERSY_DETECTOR_OUTPUT_VERSION',
  'S10_REAL_DETECTION_ACCEPTANCE',
  'controversy-detector',
];
const DETECTOR = new URL('services/controversy-detector.ts', SRC);

const AUTHORIZATION: ControlledAcceptanceAuthorization = {
  gate: 'S10_REAL_DETECTION_ACCEPTANCE',
  humanAuthorization: 'micro-gate REAL — autorisation humaine explicite du gate',
};

const EVENTS: readonly Record<string, unknown>[] = [
  {
    event_id: 'evt_000001',
    run_id: RUN_ID,
    round: 1,
    timestamp: '2026-08-18T09:10:00.000Z',
    actor: 'expert',
    type: 'assistant_response',
    expert_slot_id: 'author',
    session_id: 'S1',
    content: 'Le cache doit expirer.',
  },
  {
    event_id: 'evt_000002',
    run_id: RUN_ID,
    round: 1,
    timestamp: '2026-08-18T09:20:00.000Z',
    actor: 'expert',
    type: 'assistant_response',
    expert_slot_id: 'challenger',
    session_id: 'S2',
    content: 'Non : le cache reste valide.',
  },
];

// --------------------------------------------------------------------------
// Harnais
// --------------------------------------------------------------------------

interface Harness {
  readonly runsDir: string;
  readonly paths: RunPaths;
  readonly deps: DetectionDeps;
  readonly service: ControversyServiceDeps;
  calls(): number;
  dispose(): Promise<void>;
}

function fakeAdapter(kind: 'claude' | 'codex', content: string, calls: string[]): AgentAdapter {
  return {
    kind,
    async start(prompt: string): Promise<AgentTurnResult> {
      calls.push(prompt);
      return {
        agent: kind,
        sessionId: `detect-${kind}-1`,
        content,
        exitCode: 0,
        startedAt: '2026-08-18T10:00:00.000Z',
        completedAt: '2026-08-18T10:00:01.000Z',
        stdoutRaw: content,
        stderrRaw: '',
      };
    },
    resume(): Promise<AgentTurnResult> {
      throw new Error('sans objet');
    },
    openInteractive(): never {
      throw new Error('sans objet');
    },
  };
}

async function harness(content = ''): Promise<Harness> {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'ccr-v3-s7c-'));
  const paths = runPaths(runsDir, RUN_ID);
  await mkdir(paths.root, { recursive: true });

  await writeFile(
    paths.manifest,
    JSON.stringify({
      schema_version: 2,
      run_id: RUN_ID,
      created_at: '2026-08-18T09:00:00.000Z',
      title: 'S7-C',
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
      last_event_id: 'evt_000002',
      updated_at: '2026-08-18T09:00:00.000Z',
      pending_operation: null,
    }),
    'utf8',
  );
  await writeFile(paths.events, EVENTS.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8');

  const calls: string[] = [];
  let tick = 0;
  const now = (): Date => {
    tick += 1;
    return new Date(Date.UTC(2026, 7, 18, 12, 0, tick));
  };

  return {
    runsDir,
    paths,
    deps: {
      runsDir,
      now,
      createAdapters: () => ({
        claude: fakeAdapter('claude', content, calls),
        codex: fakeAdapter('codex', content, calls),
      }),
    },
    service: { runsDir, now },
    calls: () => calls.length,
    dispose: () => rm(runsDir, { recursive: true, force: true }),
  };
}

async function revisionOf(h: Harness): Promise<string> {
  return (await readControversyJournal(h.paths)).revision;
}

async function seed(h: Harness): Promise<string> {
  const opened = await recordControversy(h.service, {
    runId: RUN_ID,
    expected_controversy_revision: await revisionOf(h),
    provenance_event_ids: ['evt_000001'],
    statement: 'Durée de vie du cache',
  });
  const a = await recordAssertion(h.service, {
    runId: RUN_ID,
    controversy_id: opened.controversy_id,
    expected_controversy_revision: opened.controversy_revision,
    provenance_event_ids: ['evt_000001'],
    statement: 'Le TTL doit être court',
  });
  await recordAssertion(h.service, {
    runId: RUN_ID,
    controversy_id: opened.controversy_id,
    expected_controversy_revision: a.controversy_revision,
    provenance_event_ids: ['evt_000002'],
    statement: 'Le TTL doit être long',
  });
  return opened.controversy_id;
}

function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ==========================================================================
// A. Les trois faits, et la porte
// ==========================================================================

test('1 · T10 — la porte est levée, et elle ne dit rien de plus', async () => {
  assert.equal(MODEL_DETECTION_IMPLEMENTED, true, 'la capacité technique existe — S7-B');
  // Levée après le verdict PASS du micro-gate REAL, et pas avant : la valeur a
  // changé parce qu'une preuve a été produite, pas parce que le code existait.
  assert.equal(MODEL_DETECTION_RUNTIME_AVAILABILITY, 'AVAILABLE');

  // Ce que la disponibilité NE dit pas. Aucune constante du module n'affirme
  // qu'une qualité, une précision ou un rappel ont été établis.
  const detector = await readFile(DETECTOR, 'utf8');
  for (const claim of ['PRECISION', 'RECALL', 'ACCURACY', 'VALIDATED', 'QUALITY']) {
    assert.equal(detector.includes(claim), false, claim);
  }
});

test('2 · T2 — la porte ouverte dispatche, et seulement par le service gouverné', async () => {
  const h = await harness('{"detector_output_version":1,"proposals":[]}');
  try {
    const controversyId = await seed(h);

    const outcome = await requestModelDetection(h.deps, {
      runId: RUN_ID,
      controversy_id: controversyId,
      expert_slot: 'author',
    });

    assert.equal(outcome.kind, 'DISPATCHED');
    if (outcome.kind !== 'DISPATCHED') throw new Error('inatteignable');
    assert.equal(outcome.detection.kind, 'VALID_ZERO');

    // La gouvernance a bien été traversée : engagement durable, un seul appel.
    assert.equal(h.calls(), 1);
    const records = await (await openInvocationLedger(h.paths, RUN_ID)).readAll();
    assert.equal(records.length, 1);
    assert.equal(records[0]?.trigger_kind, 'CONTROVERSY_DETECTION');
    assert.equal(records[0]?.schema_version, 2);
  } finally {
    await h.dispose();
  }
});

test('3 · T4/T14 — les opérations non-détection ne sont pas touchées', async () => {
  const h = await harness();
  try {
    const controversyId = await seed(h);
    const before = (await readControversyJournal(h.paths)).entries.length;

    // Une mutation humaine S4 traverse la porte fermée sans la voir.
    const written = await recordAssertion(h.service, {
      runId: RUN_ID,
      controversy_id: controversyId,
      expected_controversy_revision: await revisionOf(h),
      provenance_event_ids: ['evt_000001'],
      statement: 'Une position humaine de plus',
    });

    assert.equal(written.entry.kind, 'ASSERTION_RECORDED');
    assert.equal(written.provider_effect, 'EXACT(0)');
    assert.equal((await readControversyJournal(h.paths)).entries.length, before + 1);
    assert.equal(h.calls(), 0);

    // Aucune garde de disponibilité ne s'est glissée devant les mutations
    // humaines : le service métier ne connaît pas le drapeau.
    const service = codeOnly(await readFile(new URL('services/controversy-service.ts', SRC), 'utf8'));
    assert.equal(service.includes('MODEL_DETECTION_RUNTIME_AVAILABILITY'), false);
    assert.equal(service.includes('requestModelDetection'), false);
  } finally {
    await h.dispose();
  }
});

// ==========================================================================
// B. Voie d'acceptation contrôlée
// ==========================================================================

test('4 · T6/T8 — l’acceptation atteint le MÊME service gouverné', async () => {
  const h = await harness('{"detector_output_version":1,"proposals":[]}');
  try {
    const controversyId = await seed(h);

    const outcome = await runControlledAcceptanceDetection(
      h.deps,
      { runId: RUN_ID, controversy_id: controversyId, expert_slot: 'author' },
      AUTHORIZATION,
    );

    // Elle traverse toute la gouvernance : engagement durable AVANT l'appel.
    assert.equal(outcome.kind, 'VALID_ZERO');
    assert.equal(h.calls(), 1, 'un seul appel, par le service gouverné');
    const ledger = await openInvocationLedger(h.paths, RUN_ID);
    assert.equal(ledger.count(), 1);
    const record = (await ledger.readAll())[0];
    assert.equal(record?.trigger_kind, 'CONTROVERSY_DETECTION');
    assert.equal(record?.schema_version, 2);
    assert.equal(record?.invocation_id, outcome.invocation_id);

    // La voie d'acceptation ne consulte pas la porte et ne la manipule pas :
    // elle est identique de part et d'autre de l'appel.
    assert.equal(MODEL_DETECTION_RUNTIME_AVAILABILITY, 'AVAILABLE');
  } finally {
    await h.dispose();
  }
});

test('5 · T7 — l’acceptation ne contourne pas le quota', async () => {
  const h = await harness('{"detector_output_version":1,"proposals":[]}');
  try {
    const controversyId = await seed(h);
    await openInvocationPolicyStore(h.paths).create(0);

    await assert.rejects(
      () =>
        runControlledAcceptanceDetection(
          h.deps,
          { runId: RUN_ID, controversy_id: controversyId, expert_slot: 'author' },
          AUTHORIZATION,
        ),
      (error: unknown) => isCcrError(error) && error.code === 'CCR_INVOCATION_QUOTA_EXCEEDED',
    );

    assert.equal(h.calls(), 0, 'aucun adaptateur : le quota a refusé avant');
    assert.equal(existsSync(h.paths.invocations), false, 'aucun engagement');
  } finally {
    await h.dispose();
  }
});

test('6 · T9 — deux autorisations distinctes, et l’une n’ouvre pas l’autre', async () => {
  const h = await harness('{"detector_output_version":1,"proposals":[]}');
  try {
    const controversyId = await seed(h);
    const request = { runId: RUN_ID, controversy_id: controversyId, expert_slot: 'author' } as const;

    // Autorisation d'acceptation manquante ou vide : refus, sans effet.
    for (const bad of [
      { gate: 'AUTRE_CHOSE', humanAuthorization: 'x' },
      { gate: 'S10_REAL_DETECTION_ACCEPTANCE', humanAuthorization: '' },
    ]) {
      await assert.rejects(
        () =>
          runControlledAcceptanceDetection(
            h.deps,
            request,
            bad as unknown as ControlledAcceptanceAuthorization,
          ),
        (error: unknown) =>
          isCcrError(error) &&
          (error.details['reason'] as string) === 'ACCEPTANCE_AUTHORIZATION_REQUIRED',
      );
    }
    assert.equal(h.calls(), 0);
    assert.equal(existsSync(h.paths.invocations), false);

    // La porte publique, elle, n'accepte aucune autorisation d'acceptation :
    // ses arguments ne portent pas ce champ, et elle passe par le service.
    const publicOutcome = await requestModelDetection(h.deps, request);
    assert.equal(publicOutcome.kind, 'DISPATCHED');
    assert.equal(h.calls(), 1);
  } finally {
    await h.dispose();
  }
});

test('7 · T5 — aucun appelant public ne peut sélectionner le mode d’acceptation', async () => {
  const detector = codeOnly(await readFile(DETECTOR, 'utf8'));

  // La voie publique ne construit aucune autorisation et n'appelle pas la voie
  // d'acceptation : sa seule sortie est le refus ou le service gouverné.
  const publicStart = detector.indexOf('export async function requestModelDetection');
  const publicEnd = detector.indexOf('export interface ControlledAcceptanceAuthorization');
  assert.ok(publicStart > 0 && publicEnd > publicStart);
  const publicPath = detector.slice(publicStart, publicEnd);
  assert.equal(publicPath.includes('runControlledAcceptanceDetection'), false);
  assert.equal(publicPath.includes('S10_REAL_DETECTION_ACCEPTANCE'), false);
  assert.equal(publicPath.includes('detectControversyRelations('), true, 'et rien d’autre');

  // L'autorisation ne peut provenir d'aucune entrée non fiable : aucune surface
  // du dépôt ne la construit ni ne nomme la voie d'acceptation.
  // La voie d'acceptation reste introuvable depuis TOUTE surface, y compris la
  // CLI publique activée après S10.
  const surfaces = [
    'cockpit/mutations-http.ts',
    'cockpit/server.ts',
    'cockpit/native-read-http.ts',
    'cli/main.ts',
    'cli/native-dispatch.ts',
  ];
  for (const relative of surfaces) {
    const code = await readFile(new URL(relative, SRC), 'utf8');
    for (const token of ['runControlledAcceptanceDetection', 'S10_REAL_DETECTION_ACCEPTANCE', 'CALL_1_ONLY']) {
      assert.equal(code.includes(token), false, `${relative} : « ${token} »`);
    }
  }

  // Et la CLI — la SEULE surface publique retenue — n'emprunte que la porte.
  const cli = codeOnly(await readFile(new URL('cli/main.ts', SRC), 'utf8'));
  assert.equal(cli.includes('requestModelDetection('), true, 'la CLI passe par la porte publique');
  assert.equal(cli.includes('detectControversyRelations'), false, 'jamais le service en direct');
  for (const relative of ['cockpit/mutations-http.ts', 'cockpit/server.ts', 'cockpit/web/render.js']) {
    const code = await readFile(new URL(relative, SRC), 'utf8');
    assert.equal(code.includes('requestModelDetection'), false, `${relative} n'expose aucune détection`);
  }
});

test('8 · T6/T14 — un seul pipeline gouverné, deux portes', async () => {
  const detector = codeOnly(await readFile(DETECTOR, 'utf8'));

  // Les deux voies convergent : chacune appelle `detectControversyRelations`,
  // et c'est le seul site d'appel d'adaptateur du dépôt pour la détection.
  const gateSection = detector.slice(detector.indexOf('const MODEL_DETECTION_IMPLEMENTED'));
  assert.equal((gateSection.match(/detectControversyRelations\(/g) ?? []).length, 2);
  assert.equal(gateSection.includes('.start('), false, 'aucune voie n’appelle un adaptateur elle-même');
  assert.equal(gateSection.includes('openInvocationLedger'), false, 'aucune n’engage elle-même');
  assert.equal(gateSection.includes('assertInvocationQuotaAvailable'), false);
  assert.equal(gateSection.includes('appendControversyEntry'), false);
  assert.equal(gateSection.includes('parseDetectorOutput'), false);
});

// ==========================================================================
// C. Ce qui n'existe pas
// ==========================================================================

test('9 · T10/T11 — aucun déclenchement automatique, aucune surface ajoutée', async () => {
  for (const relative of [
    'services/native-start-service.ts',
    'services/native-step-service.ts',
    'services/native-send-service.ts',
    'services/native-handoff-service.ts',
    'services/native-recovery-service.ts',
    'services/native-read-model.ts',
    'services/controversy-read-model.ts',
  ]) {
    const code = await readFile(new URL(relative, SRC), 'utf8');
    for (const token of ['requestModelDetection', 'detectControversyRelations', 'controversy-detector']) {
      assert.equal(code.includes(token), false, `${relative} : « ${token} »`);
    }
  }

  // Aucun bouton cockpit, aucune route HTTP de détection V3.
  //
  // La garde portait autrefois sur les chaînes `detect`, `Detect` et
  // `DETECTION`. Elle a cessé de discriminer quand V5.1 a rendu ses détections
  // structurelles `D01`–`D08` dans le cockpit : le mot appartient désormais à
  // deux concepts, et seul le SYMBOLE dit lequel.
  //
  // ```text
  // SURFACE DE DÉTECTION ASSISTÉE V3   ≠   DÉTECTIONS STRUCTURELLES V5
  // ```
  const webDir = new URL('cockpit/web/', SRC);
  for (const name of await readdir(webDir)) {
    if (!name.endsWith('.js')) continue;
    const code = await readFile(new URL(name, webDir), 'utf8');
    for (const token of V3_DETECTION_FORBIDDEN_SYMBOLS) {
      assert.equal(code.includes(token), false, `${name} : « ${token} »`);
    }
  }

  // ---- SENTINELLE. La garde reste une garde : elle attrape encore un bouton
  // qui appellerait vraiment la détection V3, et laisse passer V5.
  const boutonV3 = "button.addEventListener('click', () => api.requestModelDetection(runId));";
  assert.deepEqual(
    V3_DETECTION_FORBIDDEN_SYMBOLS.filter((symbol) => boutonV3.includes(symbol)),
    ['requestModelDetection'],
    'un bouton de détection V3 serait encore attrapé',
  );
  const boutonV5 = "el('h5', { text: 'Formes observées' }), label.reconciliationDetection(d.category)";
  assert.deepEqual(
    V3_DETECTION_FORBIDDEN_SYMBOLS.filter((symbol) => boutonV5.includes(symbol)),
    [],
    'le vocabulaire V5 n’est pas une surface V3',
  );
});

test('10 · T13/T12 — aucune preuve REAL fabriquée', async () => {
  const h = await harness('{"detector_output_version":1,"proposals":[]}');
  try {
    const controversyId = await seed(h);
    await runControlledAcceptanceDetection(
      h.deps,
      { runId: RUN_ID, controversy_id: controversyId, expert_slot: 'author' },
      AUTHORIZATION,
    );

    // Exécuter la voie d'acceptation ne crée aucun marqueur de validation :
    // ni fichier, ni drapeau mutable, ni date, ni préférence.
    const files = await readdir(h.paths.root);
    for (const name of files) {
      assert.equal(/valid|accept|gate|s10/i.test(name), false, `aucun marqueur : ${name}`);
    }
    // `invocation-outcomes.json` porte l'issue terminale de l'invocation — ici
    // `VALID_ZERO`, que la durabilité des issues objectless rend persistante.
    // Ce n'est pas un marqueur d'acceptation : la boucle ci-dessus le vérifie,
    // et son contenu ne dit rien d'une validation de la voie REAL.
    assert.deepEqual(
      files.filter((name) => name.endsWith('.json') || name.endsWith('.jsonl')).sort(),
      [
        'controversies.jsonl',
        'events.jsonl',
        'invocation-outcomes.json',
        'invocations.jsonl',
        'manifest.json',
        'state.json',
        'usage.jsonl',
      ],
    );

    // Et le drapeau n'est pas mutable : c'est une constante de module.
    const detector = await readFile(DETECTOR, 'utf8');
    assert.equal(
      detector.includes("export const MODEL_DETECTION_RUNTIME_AVAILABILITY: ModelDetectionAvailability = 'AVAILABLE'"),
      true,
    );
    // Déclaré une seule fois, et comme `const` : la mutation runtime n'est pas
    // seulement évitée, elle est impossible. La lever sera un changement de
    // code, sous l'autorité de S10.
    const code = codeOnly(detector);
    assert.equal(
      (code.match(/export const MODEL_DETECTION_RUNTIME_AVAILABILITY/g) ?? []).length,
      1,
      'une seule déclaration',
    );
    assert.equal(
      (code.match(/MODEL_DETECTION_RUNTIME_AVAILABILITY\s*=[^=]/g) ?? []).length,
      0,
      'aucune réaffectation',
    );
  } finally {
    await h.dispose();
  }
});

test('11 · le service gouverné reste atteignable directement, sans porte', async () => {
  // La voie d'acceptation n'est pas un privilège technique : elle emprunte la
  // même fonction que S7-B expose déjà. Ce test le constate, pour que personne
  // ne croie qu'une élévation cachée s'y trouve.
  const h = await harness('{"detector_output_version":1,"proposals":[]}');
  try {
    const controversyId = await seed(h);
    const direct = await detectControversyRelations(h.deps, {
      runId: RUN_ID,
      controversy_id: controversyId,
      expert_slot: 'author',
    });
    assert.equal(direct.kind, 'VALID_ZERO');
    assert.equal(h.calls(), 1);

    // Ce qui protège la production n'est pas un secret dans le service, mais
    // l'absence de toute surface appelant l'ACCEPTATION — vérifiée au test 7.
    assert.equal(MODEL_DETECTION_RUNTIME_AVAILABILITY, 'AVAILABLE');
  } finally {
    await h.dispose();
  }
});
