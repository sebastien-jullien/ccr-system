/**
 * V4 · S8 — lecture des éléments probatoires dans le cockpit.
 *
 * Question de preuve :
 *
 * > **Le cockpit peut-il montrer une adduction sans rien décider à la place du
 * > cœur, et sans transformer une attribution en verdict ?**
 *
 * Quatre propriétés.
 *
 *  1. **Une seule autorité.** Le navigateur présente `NativeRunHttpView.evidence`
 *     et rien d'autre : il ne relit aucun journal, ne joint pas les deux listes,
 *     ne recompte rien, ne résout aucune citation, ne trie rien.
 *  2. **`NOT_AVAILABLE` n'est pas zéro.** Un run que V4 ne regarde pas n'a pas
 *     « zéro matériau » : il n'a pas été regardé.
 *  3. **Rétention n'est pas adduction.** Un matériau sans aucune adduction reste
 *     visible, et son absence d'adduction ne dit rien de lui.
 *  4. **Aucun mérite.** Ni force, ni fiabilité, ni suffisance, ni score, ni
 *     gagnant, ni majorité. `SUPPORTS` n'est pas « vrai », `OBJECTS_TO` n'est pas
 *     « faux », `NONE` n'est pas « sans pertinence ».
 *
 * Le DOM factice ne connaît que `textContent` : une régression vers un sink
 * HTML n'y serait pas seulement détectée, elle serait inexprimable.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createFakeDom, SHELL_IDS } from '../helpers/fake-dom.ts';
import type { FakeNode } from '../helpers/fake-dom.ts';

const WEB = new URL('../../src/cockpit/web/', import.meta.url);
const importWeb = (name: string): Promise<Record<string, unknown>> =>
  import(new URL(name, WEB).href) as Promise<Record<string, unknown>>;

const REVISION = `ev-sha256:${'b'.repeat(64)}`;

// --------------------------------------------------------------------------
// Fixtures — exactement la forme que S3 sérialise
// --------------------------------------------------------------------------

function material(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    entry: {
      schema_version: 1,
      entry_id: 'mat_000001',
      kind: 'MATERIAL_RECORDED',
      recorded_by: 'CCR',
      recorded_at: '2026-08-18T10:00:00.000Z',
      submitted_by: 'HUMAN',
      representation: { form: 'INLINE_TEXT', text: 'Le cache expire en 30 s.' },
      observed_by_ccr: true,
      ...((over['entry'] as Record<string, unknown>) ?? {}),
    },
    verifiability: over['verifiability'] ?? { kind: 'HELD_AND_RESOLVABLE' },
  };
}

function adduction(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    entry: {
      schema_version: 1,
      entry_id: 'add_000001',
      kind: 'ADDUCTION_RECORDED',
      recorded_by: 'CCR',
      recorded_at: '2026-08-18T10:05:00.000Z',
      material_id: 'mat_000001',
      target: { kind: 'CONTROVERSY_ENTRY', entry_id: 'ctve_000002' },
      orientation: 'SUPPORTS',
      semantic_origin: 'HUMAN',
      ...((over['entry'] as Record<string, unknown>) ?? {}),
    },
    citation_resolution: over['citation_resolution'] ?? null,
  };
}

function available(
  materials: readonly Record<string, unknown>[],
  adductions: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return {
    read_model_version: 1,
    availability: 'AVAILABLE',
    evidence_revision: REVISION,
    materials,
    adductions,
    recorded_material_count: materials.length,
    recorded_adduction_count: adductions.length,
  };
}

const NOT_AVAILABLE = { read_model_version: 1, availability: 'NOT_AVAILABLE' };

function runView(evidence: Record<string, unknown> | undefined): Record<string, unknown> {
  return {
    generation: 'NATIVE_V21_EXECUTION',
    revision: `sha256:${'a'.repeat(64)}`,
    ...(evidence === undefined ? {} : { evidence }),
    run: {
      read_model_version: 1,
      identity: {
        run_id: 'CCR-20260818-003',
        execution_mode: 'NATIVE_V21_EXECUTION',
        title: 'S8 V4',
        created_at: '2026-08-18T09:00:00.000Z',
        workspace_cwd: 'E:/prog/x',
        manifest_schema_version: 2,
        state_schema_version: 3,
        runtime_schema_version: 2,
      },
      experts: {
        author: { provider: 'codex', session_id: 'codex-1', session_status: 'BOUND' },
        challenger: { provider: 'claude', session_id: 'claude-1', session_status: 'BOUND' },
      },
      compatibility: {
        provider_aliases: {
          claude: { resolution: 'UNIQUE', expert_slot: 'challenger' },
          codex: { resolution: 'UNIQUE', expert_slot: 'author' },
        },
      },
      operational_state: {
        state: 'READY',
        control: 'AUTOMATION',
        round: 1,
        next_step_source_slot: 'author',
        active_expert_slot: null,
        last_event_id: 'evt_000002',
        updated_at: '2026-08-18T09:00:00.000Z',
        pending_operation: null,
      },
      providers: null,
      recovery: {
        initialization: { status: 'NONE', available_actions: [], conflicts: [] },
        step: { status: 'NONE', available_actions: [], conflicts: [] },
        send: { status: 'NONE', available_actions: [], conflicts: [] },
        handoff: { status: 'NONE', available_actions: [], conflicts: [] },
      },
      operations: {
        step: { allowed: false },
        pause: { allowed: true, noop: false },
        resume: { allowed: true, noop: true },
        experts: {
          author: { send: { allowed: true }, handoff: { allowed: false } },
          challenger: { send: { allowed: true }, handoff: { allowed: false } },
        },
      },
      invocation_quota: { kind: 'NONE', consumed: 0, coverage: 'PRE_LEDGER' },
      usage: {
        coverage: 'PRE_LEDGER',
        invocations: { total: 0, provider_reported: { observed: 0, unobserved: 0, ambiguous: 0 } },
        providers: [],
        anomalies: { orphan_observations: [], duplicate_observations: [] },
      },
      cost_estimate: { coverage: 'PRE_LEDGER', pricing: { kind: 'NONE' }, by_invocation: [], providers: [] },
      counts: { events: 2 },
    },
  };
}

async function render(evidence: Record<string, unknown> | undefined): Promise<FakeNode | null> {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown) => Record<string, (...args: unknown[]) => void>;
  };
  const dom = createFakeDom([...SHELL_IDS]);
  createDomView(dom.document, {})['showRunView']?.(runView(evidence));
  return dom.document.getElementById('section-runtime');
}

function textOf(node: FakeNode | null): string {
  return node === null ? '' : node.textContent;
}

function findAll(root: FakeNode | null, predicate: (node: FakeNode) => boolean): FakeNode[] {
  if (root === null) return [];
  const found: FakeNode[] = [];
  const walk = (node: FakeNode): void => {
    if (predicate(node)) found.push(node);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return found;
}

function hasClass(node: FakeNode, name: string): boolean {
  return (node.attributes['class'] ?? '').split(' ').includes(name);
}

/**
 * Texte de la SEULE section V4.
 *
 * Le panneau entier contient aussi le run, les experts et les controverses —
 * dont un nom de fournisseur parfaitement légitime. Une garde qui balaierait
 * tout le panneau accuserait V4 de ce que V2.1 affiche à bon droit.
 */
function evidenceTextOf(section: FakeNode | null): string {
  const found = findAll(section, (node) => hasClass(node, 'evidence'));
  assert.ok(found.length <= 1, 'une seule section V4');
  return found.length === 0 ? '' : (found[0] as FakeNode).textContent;
}

/** Ordre d'apparition du texte : l'ordre du DOM, jamais un tri. */
function orderOf(haystack: string, needles: readonly string[]): number[] {
  return needles.map((needle) => haystack.indexOf(needle));
}

function isSorted(positions: readonly number[]): boolean {
  return positions.every(
    (value, index) => value >= 0 && (index === 0 || value > (positions[index - 1] as number)),
  );
}

/** La section V4 du module de rendu, commentaires retirés. */
async function evidenceSection(): Promise<string> {
  const raw = await readFile(new URL('render.js', WEB), 'utf8');
  const start = raw.indexOf('function evidenceNodes');
  // Borne de fin : la fonction qui suit immédiatement `evidenceNodes` dans le
  // module. Elle a changé de nom quand les faits techniques ont quitté le
  // Dossier — le repère est structurel, pas sémantique.
  const end = raw.indexOf('function nativeRunFactNodes');
  assert.ok(start > 0 && end > start, 'la section V4 est délimitée');
  return raw
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ==========================================================================
// A. Disponibilité et zéro
// ==========================================================================

test('1 · T1 — NOT_AVAILABLE est dit, et n’invente aucune liste vide', async () => {
  const text = textOf(await render(NOT_AVAILABLE));

  // Les DEUX notions utilisateur restent nommées, même sans projection : une
  // absence de lecture n'efface pas la distinction `RETENTION ≠ ADDUCTION`.
  assert.ok(text.includes('Matériaux'), 'la section Matériaux existe');
  assert.ok(text.includes('Adductions'), 'la section Adductions existe');
  assert.ok(text.includes('V4 ne s’applique pas à cette génération de run'));

  // Un run non regardé n'a pas « zéro matériau » : il n'a pas été regardé.
  for (const invented of [
    'Matériaux enregistrés',
    'Adductions enregistrées',
    'Aucun matériau V4 enregistré',
    'Aucune adduction V4 enregistrée',
    'Révision V4',
  ]) {
    assert.equal(text.includes(invented), false, `NOT_AVAILABLE ne dit pas « ${invented} »`);
  }
});

test('2 · T2 — AVAILABLE avec zéro dit un zéro ENREGISTRÉ, et rien de plus', async () => {
  const text = textOf(await render(available([], [])));

  assert.ok(text.includes('Aucun matériau V4 enregistré'));
  assert.ok(text.includes('Aucune adduction V4 enregistrée'));

  // Les comptes du serveur sont rendus — le zéro est un fait, pas un vide.
  assert.ok(text.includes('Matériaux enregistrés'));
  assert.ok(text.includes('Adductions enregistrées'));

  // Les deux messages DÉNIENT une conclusion — ils ne la posent pas. La garde
  // est donc affirmative : elle exige la dénégation, plutôt que d'interdire des
  // mots qui n'apparaissent que dans elle.
  assert.ok(text.includes('Cela ne dit pas qu’aucun élément pertinent'), 'la dénégation est là');
  assert.ok(text.includes('ne dit rien de lui'), 'le second déni est là');

  // Ce qu'aucune formulation ne doit AFFIRMER.
  for (const claimed of [
    'les experts sont d’accord',
    'aucun désaccord n’existe',
    'rien n’a été trouvé',
    'aucune preuve n’existe',
    'il n’y a rien à prouver',
  ]) {
    assert.equal(text.includes(claimed), false, claimed);
  }
});

test('3 · T3 — un matériau sans aucune adduction reste VISIBLE', async () => {
  const text = textOf(await render(available([material()], [])));

  // RÉTENTION ≠ ADDUCTION. L'enregistrement est un fait ; ne pas l'avoir versé
  // au débat en est un autre, et n'efface pas le premier.
  assert.ok(text.includes('mat_000001'), 'le matériau est là');
  assert.ok(text.includes('Le cache expire en 30 s.'));
  assert.ok(text.includes('Aucune adduction V4 enregistrée'));
  assert.equal(text.includes('add_'), false, 'aucune adduction fabriquée');
});

// ==========================================================================
// B. Ordre serveur
// ==========================================================================

test('4 · T4/T5/T6 — l’ordre du serveur est préservé, jamais retrié', async () => {
  const materials = [
    material({ entry: { entry_id: 'mat_000003', label: 'troisième' } }),
    material({ entry: { entry_id: 'mat_000001', label: 'premier' } }),
    material({ entry: { entry_id: 'mat_000002', label: 'deuxième' } }),
  ];
  const adductions = [
    adduction({ entry: { entry_id: 'add_000009', material_id: 'mat_000003', orientation: 'OBJECTS_TO' } }),
    adduction({ entry: { entry_id: 'add_000002', material_id: 'mat_000001', orientation: 'NONE' } }),
    adduction({ entry: { entry_id: 'add_000005', material_id: 'mat_000002', orientation: 'SUPPORTS' } }),
  ];
  const text = textOf(await render(available(materials, adductions)));

  // L'ordre RENDU est celui de la liste reçue — pas l'ordre trié.
  assert.ok(isSorted(orderOf(text, ['mat_000003', 'mat_000001', 'mat_000002'])), 'matériaux');
  assert.ok(isSorted(orderOf(text, ['add_000009', 'add_000002', 'add_000005'])), 'adductions');

  // Aucun regroupement par orientation, par matériau ni par origine : les deux
  // listes restent deux listes plates, dans l'ordre reçu.
  assert.ok(isSorted(orderOf(text, ['objection déclarée', 'aucune orientation déclarée', 'soutien déclaré'])));
});

test('5 · T6 — aucun tri, regroupement, dédoublonnage ni compte client', async () => {
  const section = await evidenceSection();

  for (const forbidden of [
    '.sort(', 'toSorted', 'localeCompare', 'groupBy', '.reduce(', 'new Map', 'new Set',
    '.find(', '.filter(', '.some(', '.every(', '.includes(',
    'materials.length)', 'adductions.length)',
  ]) {
    assert.equal(section.includes(forbidden), false, `section V4 : « ${forbidden} »`);
  }

  // Affirmatif : les deux comptes rendus viennent du SERVEUR, nommément.
  assert.ok(section.includes('projection.recorded_material_count'));
  assert.ok(section.includes('projection.recorded_adduction_count'));

  // Et deux entrées rigoureusement identiques restent DEUX faits.
  const twice = [adduction(), adduction({ entry: { entry_id: 'add_000002' } })];
  const nodes = findAll(await render(available([material()], twice)), (n) => hasClass(n, 'evidence-adduction'));
  assert.equal(nodes.length, 2, 'aucun dédoublonnage');
});

// ==========================================================================
// C. Orientation — un acte, jamais un résultat
// ==========================================================================

test('6 · T7/T8/T9 — les trois orientations, sans vérité ni fausseté', async () => {
  const cases = [
    ['NONE', 'aucune orientation déclarée'],
    ['SUPPORTS', 'soutien déclaré'],
    ['OBJECTS_TO', 'objection déclarée'],
  ] as const;

  for (const [orientation, expected] of cases) {
    const text = textOf(await render(available([material()], [adduction({ entry: { orientation } })])));
    assert.ok(text.includes(expected), `${orientation} → « ${expected} »`);

    for (const forbidden of [
      'vrai', 'faux', 'prouvé', 'réfuté', 'confirmé', 'validé', 'invalide', 'démenti',
      'sans pertinence', 'non pertinent', 'neutre', 'incertain', 'fort', 'faible',
    ]) {
      assert.equal(text.toLowerCase().includes(forbidden), false, `${orientation} · « ${forbidden} »`);
    }
  }
});

// ==========================================================================
// D. Origine sémantique et enregistreur
// ==========================================================================

test('7 · T10/T11/T26 — l’origine et l’enregistreur restent DEUX faits', async () => {
  // Une adduction humaine : l'origine est HUMAN, l'enregistreur est CCR.
  const human = evidenceTextOf(await render(available([material()], [adduction()])));
  assert.ok(human.includes('origine : Humain'));
  assert.ok(human.includes('Enregistré par'));
  assert.ok(human.includes('CCR'), 'l’enregistreur est visible');
  // Lire l'un pour l'autre attribuerait à CCR une position qu'un humain a prise.
  assert.equal(human.includes('origine : Inférence CCR'), false);

  // Une inférence CCR : origine CCR, méthode assistée, invocation citée.
  const assisted = evidenceTextOf(
    await render(
      available(
        [material()],
        [
          adduction({
            entry: {
              entry_id: 'add_000007',
              semantic_origin: 'CCR',
              orientation: 'OBJECTS_TO',
              derivation: {
                method: 'MODEL_ASSISTED',
                invocation_id: 'inv_000004',
                inputs: ['mat_000001', 'ctve_000001', 'ctve_000002'],
              },
            },
          }),
        ],
      ),
    ),
  );
  assert.ok(assisted.includes('origine : Inférence CCR'));
  assert.ok(assisted.includes('assistée par modèle'));
  assert.ok(assisted.includes('inv_000004'), 'référence d’audit');
  assert.ok(assisted.includes('mat_000001 · ctve_000001 · ctve_000002'), 'éléments soumis, tels quels');

  // T26 — aucun fournisseur, aucun modèle n'est projeté comme origine.
  for (const forbidden of [
    'claude', 'codex', 'anthropic', 'openai', 'gpt',
    'vérifié par l’IA', 'jugement', 'preuve automatique', 'vérité du modèle',
  ]) {
    assert.equal(assisted.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
  }
});

// ==========================================================================
// E. Vérifiabilité — un constat, jamais une qualité
// ==========================================================================

test('8 · T12/T13/T14 — les trois états, sans label de fiabilité', async () => {
  const cases = [
    [{ kind: 'HELD_AND_RESOLVABLE' }, 'représentation détenue, relue'],
    [
      { kind: 'HELD_BUT_UNRESOLVABLE', reason: 'EVENT_NOT_FOUND' },
      'représentation attendue, non relue — événement introuvable',
    ],
    [{ kind: 'NOT_OBSERVED_BY_CCR' }, 'non observé par CCR'],
  ] as const;

  for (const [verifiability, expected] of cases) {
    const text = textOf(
      await render(available([material({ verifiability })], [])),
    );
    assert.ok(text.includes(expected), `${verifiability.kind} → « ${expected} »`);

    for (const forbidden of [
      'fiable', 'peu fiable', 'douteux', 'suspect', 'faible', 'invalide', 'absent',
      'inexistant', 'manquant', 'crédible', 'corrompu', 'erroné',
    ]) {
      assert.equal(text.toLowerCase().includes(forbidden), false, `${verifiability.kind} · « ${forbidden} »`);
    }
  }
});

// ==========================================================================
// F. Citation
// ==========================================================================

test('9 · T15/T16 — la citation est rendue telle quelle, résolue ou non', async () => {
  const cited = adduction({
    entry: { citation: { quoted_text: 'le cache', occurrence: 2 } },
    citation_resolution: { kind: 'RESOLVABLE' },
  });
  const resolved = textOf(await render(available([material()], [cited])));
  assert.ok(resolved.includes('le cache'));
  assert.ok(resolved.includes('citation retrouvée dans le matériau'));
  // Le succès n'établit rien sur le fond.
  for (const forbidden of ['prouve', 'confirme', 'établit que', 'donc']) {
    assert.equal(resolved.toLowerCase().includes(forbidden), false, forbidden);
  }

  const broken = adduction({
    entry: { entry_id: 'add_000003', citation: { quoted_text: 'introuvable', occurrence: 9 } },
    citation_resolution: { kind: 'UNRESOLVABLE', reason: 'OCCURRENCE_NOT_FOUND' },
  });
  const unresolved = textOf(await render(available([material()], [broken])));

  // L'adduction reste AFFICHÉE, et n'est pas marquée invalide.
  assert.ok(unresolved.includes('add_000003'), 'l’adduction reste visible');
  assert.ok(unresolved.includes('citation non retrouvée — occurrence introuvable'));
  for (const forbidden of ['invalide', 'faux', 'rejeté', 'ignoré', 'supprimé']) {
    assert.equal(unresolved.toLowerCase().includes(forbidden), false, forbidden);
  }
});

// ==========================================================================
// G. Référence externe et empreinte déclarée
// ==========================================================================

test('10 · T17/T18 — le localisateur est du TEXTE, l’empreinte reste DÉCLARÉE', async () => {
  const external = material({
    entry: {
      entry_id: 'mat_000002',
      representation: {
        form: 'EXTERNAL_REFERENCE',
        locator: 'javascript:alert(1)',
        declared_digest: `sha256:${'c'.repeat(64)}`,
      },
      observed_by_ccr: false,
    },
    verifiability: { kind: 'NOT_OBSERVED_BY_CCR' },
  });
  const section = await render(available([external], []));
  const text = textOf(section);

  assert.ok(text.includes('javascript:alert(1)'), 'le localisateur est rendu, en texte');
  assert.ok(text.includes('Localisateur (texte, jamais un lien)'));
  assert.ok(text.includes('Empreinte DÉCLARÉE par l’appelant — jamais calculée, jamais vérifiée'));

  for (const forbidden of ['vérifiée', 'validée', 'intégrité confirmée', 'checksum']) {
    assert.equal(
      text.toLowerCase().includes(forbidden.toLowerCase().replace('vérifiée', 'vérifiée ')),
      false,
      forbidden,
    );
  }

  // Aucun nœud de la section ne devient un lien, une image ou une ressource.
  const nodes = findAll(section, () => true);
  for (const node of nodes) {
    assert.equal(node.tagName, node.tagName.toUpperCase());
    assert.equal(['A', 'IFRAME', 'IMG', 'SCRIPT', 'EMBED', 'OBJECT'].includes(node.tagName), false, node.tagName);
    for (const attribute of ['href', 'src', 'srcdoc', 'onerror', 'onclick', 'style']) {
      assert.equal(attribute in node.attributes, false, `${node.tagName}[${attribute}]`);
    }
  }
});

// ==========================================================================
// H. Sécurité de rendu
// ==========================================================================

test('11 · T19 — une charge hostile reste inerte, verbatim', async () => {
  const payloads = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '`code` **gras** [lien](javascript:alert(1))',
    '&lt;b&gt;&amp;quot;',
    '"><svg onload=alert(1)>',
  ];

  for (const payload of payloads) {
    const hostile = available(
      [
        material({
          entry: {
            entry_id: 'mat_000001',
            label: payload,
            representation: { form: 'INLINE_TEXT', text: payload },
          },
        }),
      ],
      [
        adduction({
          entry: { citation: { quoted_text: payload, occurrence: 1 } },
          citation_resolution: { kind: 'RESOLVABLE' },
        }),
      ],
    );
    const section = await render(hostile);
    const text = textOf(section);

    // Le texte est présent, **verbatim** : ni échappé en entités, ni interprété.
    assert.ok(text.includes(payload), `charge rendue telle quelle : ${payload.slice(0, 24)}`);

    // Et aucun élément n'a été créé à partir d'elle.
    const nodes = findAll(section, () => true);
    for (const node of nodes) {
      assert.equal(['SCRIPT', 'IMG', 'SVG', 'A', 'IFRAME'].includes(node.tagName), false, node.tagName);
      assert.equal(Object.keys(node.attributes).some((k) => k.startsWith('on')), false, 'aucun gestionnaire');
    }
  }

  // Le module ne contient aucun sink, hors son en-tête doctrinal.
  const section = await evidenceSection();
  for (const sink of [
    'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function',
    'setAttribute(\'href', 'setAttribute("href', 'createMarkdownContent',
  ]) {
    assert.equal(section.includes(sink), false, `section V4 : « ${sink} »`);
  }
});

// ==========================================================================
// I. Aucun contrôle, aucune autorité reconstruite
// ==========================================================================

test('12 · T20/T21/T22/T23/T24 — aucune action, aucune mutation, aucune acceptation', async () => {
  const section = await render(
    available([material()], [adduction(), adduction({ entry: { entry_id: 'add_000002' } })]),
  );

  // Aucun contrôle interactif dans la section V4.
  const controls = findAll(section, (node) => ['BUTTON', 'FORM', 'INPUT', 'SELECT', 'TEXTAREA'].includes(node.tagName));
  const inEvidence = controls.filter((node) => {
    let found = false;
    const walk = (n: FakeNode): void => {
      if (hasClass(n, 'evidence-material') || hasClass(n, 'evidence-adduction')) found = true;
      for (const child of n.children) walk(child);
    };
    walk(node);
    return found;
  });
  assert.equal(inEvidence.length, 0, 'aucun contrôle dans une carte V4');

  const code = await evidenceSection();
  for (const forbidden of [
    // Le rendu n'appelle AUCUN service métier, humain compris : il émet une
    // intention, et le cockpit l'assemble. V5.1 n'a pas changé cela.
    'registerMaterial(', 'adduceMaterial(', 'requestModelAdduction', 'adduceMaterialByModel',
    // La production assistée V4 reste FERMÉE au cockpit — addendum V3/V4 §3.3.
    'runControlledAcceptanceAdduction', 'S10_REAL_ADDUCTION_ACCEPTANCE',
    'MODEL_ADDUCTION_RUNTIME_AVAILABILITY', 'adduce-model',
    // Transport : le rendu n'émet rien lui-même.
    'fetch(', 'POST', 'PUT', 'PATCH', 'DELETE', 'Idempotency-Key',
    'expected_evidence_revision', 'onclick',
    // Sources parallèles.
    'evidence.jsonl', 'controversies.jsonl', 'invocations', 'usage', 'cost',
    // Une seule source pour cette section : la projection V4.
    'runView.controversies', 'runView.reconciliations',
  ]) {
    assert.equal(code.includes(forbidden), false, `section V4 : « ${forbidden} »`);
  }

  // V5.1 — deux gestes humains sont désormais autorisés (addendum V3/V4 §6),
  // et ils vivent HORS des cartes : ce qui est enregistré se lit, et ne se
  // modifie pas depuis son propre affichage. La garde ci-dessus le vérifie.
  const gestures = findAll(section, (node) => node.attributes['data-evidence'] !== undefined);
  assert.deepEqual(
    gestures.map((node) => node.attributes['data-evidence']),
    ['REGISTER_MATERIAL', 'ADDUCE_MATERIAL'],
    'deux gestes, distincts et dans cet ordre',
  );

  // Et aucun libellé ne propose un geste ASSISTÉ.
  const text = textOf(section);
  for (const wording of ['Demander au modèle', 'Analyser', 'Détecter', 'Réessayer', 'Lancer']) {
    assert.equal(text.includes(wording), false, `libellé d’action : « ${wording} »`);
  }
  // Les deux gestes humains, eux, se nomment — et disent ce qu'ils ne font pas.
  // Le second est renommé par la décision humaine : il ASSOCIE un matériau à
  // une controverse. La distinction qu'il portait — retenir n'est pas verser —
  // est désormais celle des deux sections qui l'entourent.
  assert.ok(text.includes('Ajouter un matériau'));
  assert.ok(text.includes('Associer un matériau à une controverse'));
  assert.ok(text.includes('Retenir un matériau ne le verse pas au débat'));
});

test('13 · T25 — aucun compte dérivé, aucun score, aucune majorité', async () => {
  const text = textOf(
    await render(
      available(
        [material()],
        [
          adduction({ entry: { entry_id: 'add_000001', orientation: 'SUPPORTS' } }),
          adduction({ entry: { entry_id: 'add_000002', orientation: 'SUPPORTS' } }),
          adduction({ entry: { entry_id: 'add_000003', orientation: 'OBJECTS_TO' } }),
        ],
      ),
    ),
  );

  // Deux soutiens et une objection sont trois faits, jamais un verdict.
  for (const forbidden of [
    '2 soutiens', '1 objection', 'majorité', 'balance', 'équilibre', 'score',
    'l’emporte', 'domine', 'plus de soutiens',
  ]) {
    assert.equal(text.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
  }

  // Les deux seuls comptes affichés sont ceux du serveur.
  assert.ok(text.includes('Matériaux enregistrés'));
  assert.ok(text.includes('Adductions enregistrées'));
});

test('14 · T20 — aucun vocabulaire de réconciliation nulle part dans la section', async () => {
  const code = await evidenceSection();
  const text = evidenceTextOf(
    await render(available([material()], [adduction({ entry: { semantic_origin: 'CCR' } })])),
  );

  // S8 reste Evidence Engine, pas Reconciliation Engine. Le RENDU est balayé
  // sur le vocabulaire français, dans la seule section V4.
  for (const token of [
    'suffisan', 'insuffisan', 'crédib', 'fiabilit', 'force probante', 'décisif',
    'tranché', 'résolu', 'convergen', 'clôtur', 'gagnant', 'perdant', 'classement',
    'confiance', 'probabilit', 'pondér', 'preuve préférée',
  ]) {
    assert.equal(text.toLowerCase().includes(token), false, `rendu : « ${token} »`);
  }

  // Le CODE est balayé sur des identifiants sans homonymie possible. « fiabilit »
  // n'y figure pas : il est contenu dans « veri-fiabilit-y », qui nomme le
  // constat mécanique du contrat, pas une qualité de la pièce.
  for (const token of [
    'score', 'winner', 'confidence', 'weight', 'sufficiency', 'reliability',
    'credibility', 'majority', 'ranking', 'threshold', 'CONVERGED', 'closure',
  ]) {
    assert.equal(code.includes(token), false, `code : « ${token} »`);
  }
  // Affirmatif : les libellés employés sont ceux du vocabulaire descriptif.
  assert.ok(code.includes('label.orientation('));
  assert.ok(code.includes('label.materialVerifiability('));
});

// ==========================================================================
// J. Fraîcheur et frontière d'autorité
// ==========================================================================

test('15 · T27 — la révision V4 est reprise du serveur, jamais recalculée', async () => {
  const text = evidenceTextOf(await render(available([material()], [])));

  assert.ok(text.includes('Révision V4'));
  // Forme courte, dérivée de la valeur REÇUE — aucun hachage n'est calculé. Et
  // l'espace de noms `ev-sha256:` reste visible : les trois révisions du dépôt
  // ne se comparent jamais, et les confondre serait le défaut à éviter.
  assert.ok(text.includes('ev-sha256:'), 'l’espace de noms V4 est lisible');
  assert.equal(text.includes(`sha256:${'a'.repeat(12)}`), false, 'jamais la révision de run');

  const code = await evidenceSection();
  for (const forbidden of ['createHash', 'sha256(', 'digest(', 'crypto']) {
    assert.equal(code.includes(forbidden), false, `section V4 : « ${forbidden} »`);
  }
  // Affirmatif : la valeur vient du champ du serveur.
  assert.ok(code.includes('projection.evidence_revision'));
});

test('16 · la source est UNIQUE : `runView.evidence`, et rien d’autre', async () => {
  const code = await evidenceSection();

  assert.ok(code.includes('runView.evidence'), 'la seule source lue');
  // Aucune autre branche de la vue n'est consultée pour enrichir V4.
  for (const forbidden of [
    'runView.controversies', 'runView.run.usage', 'runView.run.cost_estimate',
    'runView.run.invocation_quota', 'NativeRunSnapshot', 'readEvidenceJournal',
  ]) {
    assert.equal(code.includes(forbidden), false, `section V4 : « ${forbidden} »`);
  }

  // Une vue sans champ `evidence` ne rend rien, plutôt qu'un zéro inventé.
  const text = textOf(await render(undefined));
  assert.equal(text.includes('Éléments probatoires'), false, 'aucune section fabriquée');
});

test('17 · une orientation absente ou inconnue n’est JAMAIS déduite', async () => {
  // Absente : rien ne la remplace. Le contrat interdit qu'une orientation
  // manquante soit reconstruite, et un défaut d'affichage serait exactement
  // cette reconstruction — la plus invisible de toutes.
  const missing = evidenceTextOf(
    await render(available([material()], [adduction({ entry: { orientation: undefined } })])),
  );
  assert.equal(missing.includes('aucune orientation déclarée'), false, 'absente ≠ NONE');
  assert.equal(missing.includes('soutien déclaré'), false);
  assert.equal(missing.includes('objection déclarée'), false);
  assert.ok(missing.includes('add_000001'), 'l’adduction reste visible, sans orientation inventée');

  // Inconnue : rendue VERBATIM, jamais rapprochée d'une des trois valeurs.
  const unknown = evidenceTextOf(
    await render(available([material()], [adduction({ entry: { orientation: 'MAYBE_SUPPORTS' } })])),
  );
  assert.ok(unknown.includes('MAYBE_SUPPORTS'), 'la valeur reçue est montrée telle quelle');
  for (const mapped of ['aucune orientation déclarée', 'soutien déclaré', 'objection déclarée']) {
    assert.equal(unknown.includes(mapped), false, `« MAYBE_SUPPORTS » traduit en « ${mapped} »`);
  }
});
