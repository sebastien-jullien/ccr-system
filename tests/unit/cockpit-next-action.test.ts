/**
 * V2.3-S4 — prochaine action, gouvernance, création guidée.
 *
 * Question de preuve :
 *
 * > **L'interface n'affirme-t-elle que des faits autoritaires ?**
 *
 * Trois propriétés.
 *
 *  1. **La priorité est visuelle, jamais une capacité.** Aucune branche
 *     n'active un bouton que le cœur n'autorise pas.
 *  2. **Aucun nombre n'est inventé.** `UNKNOWN` ne devient jamais `0`,
 *     `AT_MOST` jamais `EXACT`, et l'effet de START vient du transport.
 *  3. **Rien n'est fabriqué faute de fait.** Pricing absent : aucun montant.
 *     Usage absent : aucune observation. Couverture partielle : dite.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createFakeDom, SHELL_IDS } from '../helpers/fake-dom.ts';
import type { FakeNode } from '../helpers/fake-dom.ts';
import { operationEffect } from '../../src/services/invocation-effect.ts';

const WEB = new URL('../../src/cockpit/web/', import.meta.url);
const importWeb = (name: string): Promise<Record<string, unknown>> =>
  import(new URL(name, WEB).href) as Promise<Record<string, unknown>>;

type View = Record<string, (...args: unknown[]) => void>;

const capability = (allowed: boolean, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  allowed,
  ...over,
});

function runView(over: Record<string, unknown> = {}): Record<string, unknown> {
  const base = {
    generation: 'NATIVE_V21_EXECUTION',
    revision: `sha256:${'b'.repeat(64)}`,
    presentation: {
      presentation_version: 1,
      actions: [
        operationEffect('STEP'),
        operationEffect('SEND'),
        operationEffect('PAUSE'),
        operationEffect('RESUME'),
        operationEffect('HANDOFF'),
      ],
      latest_contributions: { author: null, challenger: null },
      initial_context: { status: 'UNAVAILABLE', reason: 'NOT_FOUND', event_ids: [] },
    },
    run: {
      read_model_version: 1,
      identity: {
        run_id: 'CCR-20260811-002',
        execution_mode: 'NATIVE_V21_EXECUTION',
        title: 'Contre-expertise',
        created_at: '2026-08-11T00:00:00.000Z',
        workspace_cwd: 'E:/prog/exemple',
        manifest_schema_version: 2,
        state_schema_version: 2,
        runtime_schema_version: 2,
      },
      experts: {
        author: { provider: 'codex', session_id: 'S1', session_status: 'BOUND' },
        challenger: { provider: 'claude', session_id: 'S2', session_status: 'BOUND' },
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
        last_event_id: 'evt_000010',
        updated_at: '2026-08-11T00:00:00.000Z',
        pending_operation: null,
      },
      providers: null,
      invocation_quota: { kind: 'NONE', consumed: 0, coverage: 'PRE_LEDGER' },
      usage: {
        coverage: 'PRE_LEDGER',
        invocations: { total: 0, provider_reported: { observed: 0, unobserved: 0, ambiguous: 0 } },
        providers: [],
        anomalies: { orphan_observations: [], duplicate_observations: [] },
      },
      cost_estimate: { coverage: 'PRE_LEDGER', pricing: { kind: 'NONE' }, by_invocation: [], providers: [] },
      recovery: {
        initialization: { status: 'NONE', available_actions: [], conflicts: [] },
        step: { status: 'NONE', available_actions: [], conflicts: [] },
        send: { status: 'NONE', available_actions: [], conflicts: [] },
        handoff: { status: 'NONE', available_actions: [], conflicts: [] },
      },
      operations: {
        step: capability(true, {
          source_status: 'AVAILABLE',
          source_slot: 'author',
          target_slot: 'challenger',
          source_event_id: 'evt_000010',
          next_round: 2,
          payload_bytes: 5577,
        }),
        pause: capability(true, { noop: false }),
        resume: capability(false, { noop: false, reason_code: 'RUN_NOT_PAUSED' }),
        experts: {
          author: { send: capability(false, { reason_code: 'RUN_BUSY' }), handoff: capability(false) },
          challenger: { send: capability(false, { reason_code: 'RUN_BUSY' }), handoff: capability(false) },
        },
      },
      counts: { events: 12 },
    },
  };
  return deepMerge(base, over) as Record<string, unknown>;
}

function deepMerge(base: unknown, over: unknown): unknown {
  if (over === undefined) return base;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return over;
  if (typeof over !== 'object' || over === null || Array.isArray(over)) return over;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(over as Record<string, unknown>)) {
    out[key] = deepMerge((base as Record<string, unknown>)[key], value);
  }
  return out;
}

async function render(view: Record<string, unknown>): Promise<{
  dom: ReturnType<typeof createFakeDom>;
  api: View;
}> {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown, options?: unknown) => View;
  };
  const dom = createFakeDom([...SHELL_IDS]);
  const api = createDomView(dom.document, {});
  api['showRunView']?.(view);
  return { dom, api };
}

const textOf = (node: FakeNode | null): string => (node === null ? '' : node.textContent);
const workspace = (dom: ReturnType<typeof createFakeDom>): string =>
  textOf(dom.document.getElementById('section-overview'));

/** Texte de la seule carte de prochaine action — la gouvernance est ailleurs. */
function nextAction(dom: ReturnType<typeof createFakeDom>): string {
  const cards = dom.created.filter((node) => node.attributes['class'] === 'next-action');
  assert.equal(cards.length, 1, 'une seule carte de prochaine action');
  return textOf(cards[0] ?? null);
}

async function executable(name: string): Promise<string> {
  const raw = await readFile(new URL(name, WEB), 'utf8');
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

// ==========================================================================
// A. Priorité de la prochaine action
// ==========================================================================

test('1–4 · la priorité suit l’ordre gelé, et n’accorde aucune capacité', async () => {
  // 2 · STEP autorisé prime lorsqu'aucune reprise n'est disponible.
  const step = await render(runView());
  assert.ok(workspace(step.dom).includes('Transmettre la réponse de Auteur — Codex à Challenger — Claude'));

  // 1 · une reprise disponible prime sur tout le reste.
  const recovery = await render(
    runView({ run: { recovery: { step: { status: 'RESPONSE_NEEDS_FINALIZATION', available_actions: ['FINALIZE'] } } } }),
  );
  const recoveryText = workspace(recovery.dom);
  assert.ok(recoveryText.includes('Une reprise est disponible'));
  assert.equal(recoveryText.includes('Transmettre la réponse'), false, 'le transfert cède la place');

  // 3 · sinon, un envoi autorisé prime.
  const send = await render(
    runView({
      run: {
        operations: {
          step: { allowed: false, source_status: 'MISSING' },
          experts: { author: { send: { allowed: true } } },
        },
      },
    }),
  );
  assert.ok(workspace(send.dom).includes('Écrire à Auteur — Codex'));

  // 4 · sinon, un état vide explicite — et le motif du refus reste lisible.
  const empty = await render(
    runView({ run: { operations: { step: { allowed: false, source_status: 'MISSING' } } } }),
  );
  const emptyText = workspace(empty.dom);
  assert.ok(emptyText.includes('Aucune action n’est proposée'));
  assert.ok(emptyText.includes('Transfert :'), 'le motif du refus est traduit');
  assert.ok(emptyText.includes('aucune réponse transférable'), 'le code est traduit');
  assert.equal(emptyText.includes('MISSING'), false, 'aucun code brut seul');
});

test('5–7 · les effets sont rendus tels qu’ils sont transportés', async () => {
  // 5 · EXACT(1) — la valeur vient de la primitive, pas d'un littéral local.
  const exact = await render(runView());
  assert.ok(nextAction(exact.dom).includes('Engage 1 invocation CCR.'));

  // 6 · AT_MOST(n) se dit « jusqu'à », jamais « exactement ».
  const atMost = await render(
    runView({ presentation: { actions: [{ operation: 'STEP', may_call_provider: 'YES', invocation_effect: { kind: 'AT_MOST', count: 3 } }] } }),
  );
  const atMostText = nextAction(atMost.dom);
  assert.ok(atMostText.includes('Peut engager jusqu’à 3 invocations CCR.'));
  assert.equal(atMostText.includes('Engage 3 invocation'), false);

  // 7 · UNKNOWN avec appel possible : aucune quantité inventée.
  const unknown = await render(
    runView({ presentation: { actions: [{ operation: 'STEP', may_call_provider: 'YES', invocation_effect: { kind: 'UNKNOWN' } }] } }),
  );
  const unknownText = nextAction(unknown.dom);
  assert.ok(unknownText.includes('Peut appeler un fournisseur.'));
  assert.equal(/\d+\s+invocation/.test(unknownText), false, 'UNKNOWN ne devient jamais un compte');
});

test('8 · un effet absent ne produit aucune phrase de conséquence', async () => {
  const { dom } = await render(runView({ presentation: { actions: [] } }));
  const text = nextAction(dom);
  assert.ok(text.includes('Transmettre la réponse'), 'l’action reste présentée');
  assert.equal(text.includes('invocation CCR'), false, 'aucune conséquence fabriquée');
});

test('9 · same-provider : les deux rôles restent distincts dans la prochaine action', async () => {
  const { dom } = await render(
    runView({ run: { experts: { author: { provider: 'claude' }, challenger: { provider: 'claude' } } } }),
  );
  assert.ok(workspace(dom).includes('de Auteur — Claude à Challenger — Claude'));
});

// ==========================================================================
// B. Gouvernance
// ==========================================================================

test('10–13 · quota : absent, configuré, épuisé, couverture partielle', async () => {
  // 10 · PRE_LEDGER : la couverture prend la place du compte, qui serait faux.
  const none = await render(runView());
  const noneText = workspace(none.dom);
  assert.ok(noneText.includes('aucune limite CCR'));
  assert.ok(noneText.includes('aucun journal d’invocations sur ce run'));
  assert.ok(noneText.includes('l’activité antérieure n’est pas comptée'));

  // 11 · configuré : consommé, limite, restant.
  const configured = await render(
    runView({
      run: {
        invocation_quota: {
          kind: 'CONFIGURED',
          consumed: 2,
          limit: 5,
          remaining: 3,
          exhausted: false,
          coverage: 'SINCE_LEDGER_START',
        },
      },
    }),
  );
  const configuredText = workspace(configured.dom);
  assert.ok(configuredText.includes('2 engagées sur 5'));
  assert.ok(configuredText.includes('3 restantes'));
  assert.equal(configuredText.includes('aucun journal'), false, 'couverture complète : rien à signaler');
  assert.equal(configuredText.includes('n’est pas comptée'), false);

  // 12 · épuisé : dit explicitement, pas seulement « 0 restant ».
  const exhausted = await render(
    runView({
      run: {
        invocation_quota: {
          kind: 'CONFIGURED',
          consumed: 3,
          limit: 3,
          remaining: 0,
          exhausted: true,
          coverage: 'SINCE_LEDGER_START',
        },
      },
    }),
  );
  assert.ok(workspace(exhausted.dom).includes('ÉPUISÉ'));
});

test('14–15 · usage : absent puis observé, sans jamais inventer un compteur', async () => {
  const absent = await render(runView());
  assert.ok(workspace(absent.dom).includes('aucune observation fournisseur'));
  assert.equal(workspace(absent.dom).includes('0 token'), false);

  const observed = await render(
    runView({
      run: {
        usage: {
          invocations: { total: 3, provider_reported: { observed: 2, unobserved: 1, ambiguous: 0 } },
        },
      },
    }),
  );
  const text = workspace(observed.dom);
  assert.ok(text.includes('2 invocations observées'));
  assert.ok(text.includes('1 invocation sans observation'));
});

test('16–18 · estimation : aucun montant sans catalogue, un montant sinon', async () => {
  // 16 · pricing NONE : une phrase, aucun chiffre monétaire.
  const none = await render(runView());
  const noneText = workspace(none.dom);
  // La valeur de tête et sa précision sont deux éléments distincts depuis que la
  // gouvernance se lit en grille. Aucun mot n'a été retiré : les deux sont exigés.
  assert.ok(noneText.includes('indisponible'));
  assert.ok(noneText.includes('aucun catalogue tarifaire'));
  assert.equal(/\d+[.,]\d+\s+[A-Z]{3}/.test(noneText), false, 'aucun montant affiché');

  // 17 · catalogue synthétique configuré, mais rien d'estimable.
  const empty = await render(
    runView({
      run: {
        cost_estimate: {
          pricing: { kind: 'CONFIGURED', catalog_version: 'TEST-COST-V1', currency: 'XTS' },
          providers: [],
        },
      },
    }),
  );
  assert.ok(workspace(empty.dom).includes('aucune invocation estimable'));

  // 18 · un montant estimé, avec sa devise et son marqueur d'approximation.
  const known = await render(
    runView({
      run: {
        cost_estimate: {
          pricing: { kind: 'CONFIGURED', catalog_version: 'TEST-COST-V1', currency: 'XTS' },
          providers: [
            {
              provider: 'claude',
              amounts_by_currency: [
                {
                  currency: 'XTS',
                  estimated_amount_sum: '4.5',
                  estimated_invocations: 2,
                  exact_amount_invocations: 1,
                  rounded_amount_invocations: 1,
                },
              ],
            },
          ],
        },
      },
    }),
  );
  assert.ok(workspace(known.dom).includes('≈4.5 XTS'), 'montant et approximation dits');
});

test('19 · le montant rapporté par un fournisseur n’est jamais rendu comme estimation', async () => {
  const code = await executable('render.js');
  const start = code.indexOf('function governanceNodes');
  const end = code.indexOf('function nativeOverviewNodes');
  assert.ok(start >= 0 && end > start, 'la zone de gouvernance est isolable');
  const region = code.slice(start, end);
  // `provider_reported_cost` est le champ **par invocation** du journal
  // d'usage. La gouvernance ne le lit jamais : elle lit l'agrégat déjà
  // constitué par IMP-10, et le rend sous son propre nom.
  assert.equal(region.includes('provider_reported_cost'), false);
});

// ==========================================================================
// C. Transport de l'effet START
// ==========================================================================

test('20–22 · le résumé de création vient du transport, jamais d’un littéral', async () => {
  const { dom, api } = await render(runView());
  const summary = (): string => textOf(dom.document.getElementById('start-summary'));

  // 20 · sans transport, aucun compte n'est affiché.
  api['showStartEffect']?.(null);
  assert.ok(summary().includes('non transporté'));
  assert.equal(summary().includes('2 invocations'), false, 'aucun repli silencieux vers 2');

  // 21 · avec le fait autoritaire, le compte transporté est rendu.
  api['showStartEffect']?.(operationEffect('START'));
  assert.ok(summary().includes('peut engager jusqu’à 2 invocations CCR'), summary());

  // 22 · et il suit le transport, pas une constante : un autre compte s'affiche.
  api['showStartEffect']?.({ may_call_provider: 'YES', invocation_effect: { kind: 'AT_MOST', count: 7 } });
  const seven = summary();
  assert.ok(seven.includes('jusqu’à 7 invocations CCR'), seven);
  assert.equal(seven.includes('2 invocations'), false);
});

test('23 · aucune table d’effet ne vit dans le frontend ni dans la projection HTTP', async () => {
  const render = await executable('render.js');
  const cockpit = await executable('cockpit.js');
  const labels = await executable('labels.js');

  // Aucun module navigateur ne nomme les formes de l'union : il les reçoit.
  for (const code of [cockpit, labels]) {
    assert.equal(code.includes('AT_MOST'), false, 'une forme d’effet est recopiée');
  }
  // `render.js` les LIT — il compare — mais n'en construit aucune.
  assert.equal(render.includes("kind: 'AT_MOST'"), false, 'un effet est fabriqué');
  assert.equal(render.includes("kind: 'EXACT'"), false, 'un effet est fabriqué');
  assert.equal(render.includes('invocation_effect ='), false, 'un effet est assigné localement');

  // La garde qui compte : le résumé de création ne contient aucun compte en dur.
  const start = render.indexOf('function startSummaryNodes');
  const end = render.indexOf('function startCheck');
  const region = render.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.equal(/count\s*[:=]\s*\d/.test(region), false, 'un compte est écrit en dur dans le résumé');
  assert.ok(region.includes('effectSentence(startEffect)'), 'le résumé consomme le transport');

  // Côté serveur : le fait est demandé à la primitive, jamais réécrit.
  const serverRaw = await readFile(new URL('../../src/cockpit/server.ts', import.meta.url), 'utf8');
  const server = serverRaw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
  assert.ok(server.includes("operationEffect('START')"), 'le serveur interroge la primitive');
  assert.equal(server.includes('AT_MOST'), false, 'le serveur réécrit une forme d’effet');
});

// ==========================================================================
// D. New Run
// ==========================================================================

test('24–27 · les six champs, les obligatoires, et le zéro conservé', async () => {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown, options?: unknown) => View;
  };
  const dom = createFakeDom([...SHELL_IDS]);
  const payloads: Record<string, unknown>[] = [];
  const api = createDomView(dom.document, { onCreateRun: (payload: Record<string, unknown>) => payloads.push(payload) });

  const set = (id: string, value: string): void => {
    const node = dom.document.getElementById(id);
    if (node !== null) node.value = value;
  };
  // Depuis A-N-P2-01, une soumission gèle le formulaire jusqu'à son issue.
  // Chaque soumission de ce test est donc une demande DISTINCTE : on rend
  // l'issue entre deux, exactement comme le fait la production.
  const submit = (): void => {
    dom.document.getElementById('start-submit')?.click();
    api['showStartFailed']?.({ code: 'INTERNAL_ERROR', message: 'issue simulée', retryable: false }, undefined);
  };

  // 24 · les trois champs obligatoires seuls : rien d'autre n'est envoyé.
  set('start-title', 'Sujet');
  set('start-workspace', 'E:/prog/x');
  set('start-prompt', 'Contexte');
  submit();
  assert.deepEqual(payloads[0], { title: 'Sujet', workspace_cwd: 'E:/prog/x', prompt: 'Contexte' });

  // 25 · 26 · les deux fournisseurs, y compris identiques pour les deux rôles.
  set('start-author', 'claude');
  set('start-challenger', 'claude');
  submit();
  assert.equal(payloads[1]?.['author_provider'], 'claude');
  assert.equal(payloads[1]?.['challenger_provider'], 'claude');

  // 27 · `0` est une limite explicite : elle survit à la vérité JS.
  set('start-max-invocations', '0');
  submit();
  assert.equal(payloads[2]?.['max_invocations'], 0);
  assert.ok('max_invocations' in (payloads[2] ?? {}), 'zéro n’est pas une absence');

  // Une limite positive passe telle quelle ; un champ vide reste absent.
  set('start-max-invocations', '5');
  submit();
  assert.equal(payloads[3]?.['max_invocations'], 5);
  set('start-max-invocations', '');
  submit();
  assert.equal('max_invocations' in (payloads[4] ?? {}), false);

  // Aucun champ inventé : la charge reste dans le contrat de l'API.
  const allowed = ['title', 'workspace_cwd', 'prompt', 'author_provider', 'challenger_provider', 'max_invocations'];
  for (const payload of payloads) {
    for (const key of Object.keys(payload)) {
      assert.ok(allowed.includes(key), `champ inventé : ${key}`);
    }
  }
});

test('28 · le résumé nomme les deux rôles, même sous un fournisseur unique', async () => {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown, options?: unknown) => View;
  };
  const dom = createFakeDom([...SHELL_IDS]);
  const api = createDomView(dom.document, {});
  const author = dom.document.getElementById('start-author');
  const challenger = dom.document.getElementById('start-challenger');
  if (author !== null) author.value = 'claude';
  if (challenger !== null) challenger.value = 'claude';
  api['showStartEffect']?.(operationEffect('START'));

  const summary = textOf(dom.document.getElementById('start-summary'));
  assert.ok(summary.includes('Auteur : Claude'));
  assert.ok(summary.includes('Challenger : Claude'));
  assert.ok(summary.includes('l’un après l’autre'));
});

// ==========================================================================
// V2.3-S4R — réparations ciblées
// ==========================================================================

/** Ligne de gouvernance, isolée du reste de l'espace de travail. */
function governance(dom: ReturnType<typeof createFakeDom>): string {
  const text = workspace(dom);
  const start = text.indexOf('Gouvernance');
  assert.ok(start >= 0, 'la zone de gouvernance existe');
  return text.slice(start);
}

test('29 · PRE_LEDGER ne présente JAMAIS un compte comme total du run', async () => {
  for (const quota of [
    { kind: 'NONE', consumed: 0, coverage: 'PRE_LEDGER' },
    { kind: 'NONE', consumed: 4, coverage: 'PRE_LEDGER' },
    { kind: 'CONFIGURED', consumed: 0, limit: 3, remaining: 3, exhausted: false, coverage: 'PRE_LEDGER' },
  ]) {
    const { dom } = await render(runView({ run: { invocation_quota: quota } }));
    const text = governance(dom);
    const line = text.slice(0, text.indexOf('Usage'));

    // Le test négatif fort : aucune formulation de compte d'invocations ne
    // doit apparaître sur cette ligne, quel que soit le nombre — un « 0
    // invocation engagée » comme un « 4 invocations engagées » y affirmerait un total que la
    // couverture interdit.
    assert.equal(
      /\d+\s*(engagée|invocation)|engagée?s?\s*:\s*\d+/.test(line),
      false,
      `compte présenté comme total : ${line}`,
    );
    assert.equal(/\d+\s*\/\s*\d+/.test(line), false, 'aucun ratio consommé/limite sous PRE_LEDGER');
    assert.ok(line.includes('aucun journal d’invocations sur ce run'));
    assert.ok(line.includes('n’est pas comptée'));
  }
});

test('30–33 · le montant rapporté par le fournisseur vit à côté de l’estimation', async () => {
  const money = {
    providers: [
      {
        provider: 'claude',
        provider_reported_money: {
          by_currency: [{ currency: 'USD', observed_amount_sum: 0.25, covered_invocations: 2 }],
          unknown_invocations: 1,
          ambiguous_invocations: 0,
        },
      },
    ],
  };

  // 30 · (A) estimation indisponible + montant rapporté connu : le montant
  //      s'affiche comme OBSERVATION, et ne devient jamais l'estimation.
  const unknownEstimate = await render(runView({ run: { usage: money } }));
  const a = governance(unknownEstimate.dom);
  assert.ok(a.includes('Montant rapporté par le fournisseur'));
  assert.ok(a.includes('0.25 USD'));
  assert.ok(a.includes('indisponible'), 'l’estimation reste indisponible');
  assert.ok(a.includes('aucun catalogue tarifaire'), 'et le motif de son absence est dit');
  // La ligne « Estimation » ne porte aucun montant.
  const estimateLine = a.slice(a.indexOf('Estimation'), a.indexOf('Montant rapporté'));
  assert.equal(/\d+[.,]\d+\s+[A-Z]{3}/.test(estimateLine), false, 'le montant tiers a comblé l’estimation');

  // 31 · (B) les deux connus : deux lignes, deux noms, deux valeurs.
  const both = await render(
    runView({
      run: {
        usage: money,
        cost_estimate: {
          pricing: { kind: 'CONFIGURED', catalog_version: 'TEST-COST-V1', currency: 'XTS' },
          providers: [
            {
              provider: 'claude',
              amounts_by_currency: [
                {
                  currency: 'XTS',
                  estimated_amount_sum: '4.5',
                  estimated_invocations: 2,
                  exact_amount_invocations: 2,
                  rounded_amount_invocations: 0,
                },
              ],
            },
          ],
        },
      },
    }),
  );
  const b = governance(both.dom);
  assert.ok(b.includes('4.5 XTS'), 'l’estimation CCR');
  assert.ok(b.includes('0.25 USD'), 'l’observation fournisseur');
  assert.ok(b.indexOf('Estimation') < b.indexOf('Montant rapporté'), 'deux lignes distinctes');

  // 32 · (C) aucune observation monétaire : aucune ligne, aucune valeur.
  const nothing = await render(runView());
  assert.equal(governance(nothing.dom).includes('Montant rapporté'), false);

  // 33 · (D) pricing NONE + montant fournisseur : l'observation est visible,
  //      et aucun CostEstimate n'apparaît pour autant.
  const d = governance(unknownEstimate.dom);
  assert.ok(d.includes('Montant rapporté par le fournisseur'));
  assert.equal(d.includes('catalogue TEST'), false);
});

test('34 · le montant fournisseur n’est jamais un repli de l’estimation', async () => {
  const code = await executable('render.js');
  const start = code.indexOf('function governanceNodes');
  const end = code.indexOf('function nativeOverviewNodes');
  assert.ok(start >= 0 && end > start);
  const region = code.slice(start, end);

  // La garde utile n'interdit plus la lecture — elle interdit la substitution.
  // Le montant tiers est lu depuis `usage`, jamais depuis `cost`, et la
  // branche `pricing NONE` ne le consulte pas.
  assert.ok(region.includes('provider_reported_money'), 'l’observation est lue');
  assert.equal(region.includes('cost.provider_reported'), false, 'jamais depuis la vue de coût');
  const pricingNone = region.slice(region.indexOf("cost.pricing.kind === 'NONE'"));
  const untilElse = pricingNone.slice(0, pricingNone.indexOf('} else {'));
  assert.equal(untilElse.includes('provider_reported_money'), false, 'l’estimation absente n’est pas comblée');
  assert.equal(untilElse.includes('observed_amount_sum'), false);
});

test('35–37 · le résumé de création suit les sélecteurs, immédiatement', async () => {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown, options?: unknown) => View;
  };
  const dom = createFakeDom([...SHELL_IDS]);
  const api = createDomView(dom.document, {});
  api['showStartEffect']?.(operationEffect('START'));

  const select = (id: string, value: string): void => {
    const node = dom.document.getElementById(id);
    if (node === null) return;
    node.value = value;
    for (const handler of node.listeners['change'] ?? []) handler();
  };
  const summary = (): string => textOf(dom.document.getElementById('start-summary'));

  // 35 · état initial, deux moteurs différents.
  select('start-author', 'codex');
  select('start-challenger', 'claude');
  assert.ok(summary().includes('Auteur : Codex'), summary());
  assert.ok(summary().includes('Challenger : Claude'));

  // 36 · same-provider : les deux rôles restent distincts.
  select('start-author', 'claude');
  const same = summary();
  assert.ok(same.includes('Auteur : Claude'));
  assert.ok(same.includes('Challenger : Claude'));
  assert.equal(same.includes('Codex'), false, 'l’ancienne sélection ne survit pas');

  // 37 · et dans l'autre sens.
  select('start-author', 'codex');
  select('start-challenger', 'codex');
  const codex = summary();
  assert.ok(codex.includes('Auteur : Codex'));
  assert.ok(codex.includes('Challenger : Codex'));
  assert.equal(codex.includes('Claude'), false);

  // La phrase d'effet reste celle du transport, inchangée par ces sélections.
  assert.ok(codex.includes('peut engager jusqu’à 2 invocations CCR'));
});

test('38–39 · la promotion de la reprise suit le STATUT, pas l’existence d’un geste', async () => {
  // 38 · run sain : les quatre domaines valent NONE, le transfert reste
  //      l'action principale même si l'onglet Recovery existe.
  const healthy = await render(runView());
  const healthyText = nextAction(healthy.dom);
  assert.ok(healthyText.includes('Transmettre la réponse'));
  assert.equal(healthyText.includes('Une reprise est disponible'), false);

  // 39 · un conflit de faits n'offre AUCUN geste, et exige pourtant une
  //      attention : c'est le statut qui le matérialise, pas `available_actions`.
  const conflict = await render(
    runView({
      run: {
        recovery: {
          send: { status: 'EVIDENCE_CONFLICT', available_actions: [], conflicts: ['faits contradictoires'] },
        },
      },
    }),
  );
  const conflictText = nextAction(conflict.dom);
  assert.ok(conflictText.includes('Une reprise requiert votre attention'), conflictText);
  assert.equal(conflictText.includes('Transmettre la réponse'), false, 'le transfert cède la place');
});

// ==========================================================================
// V2.3-S4R2 — le libellé de reprise dit ce que les faits permettent
// ==========================================================================

test('40 · (A) un geste disponible : la carte l’annonce, et il est nommé', async () => {
  const { dom } = await render(
    runView({
      run: {
        recovery: {
          step: {
            status: 'RESPONSE_NEEDS_FINALIZATION',
            available_actions: ['FINALIZE'],
            conflicts: [],
          },
        },
      },
    }),
  );
  const text = nextAction(dom);
  assert.ok(text.includes('Une reprise est disponible'));
  assert.ok(text.includes('Transfert'), 'le domaine concerné est nommé');
  assert.ok(text.includes('Les gestes de reprise'), 'la carte renvoie vers les gestes');
  assert.equal(text.includes('requiert votre attention'), false);
});

test('41 · (B) un conflit sans geste : aucune disponibilité n’est affirmée', async () => {
  const { dom } = await render(
    runView({
      run: {
        recovery: {
          send: {
            status: 'EVIDENCE_CONFLICT',
            available_actions: [],
            conflicts: ['deux faits canoniques se contredisent'],
          },
        },
      },
    }),
  );
  const text = nextAction(dom);

  // Ce que la carte doit dire.
  assert.ok(text.includes('Une reprise requiert votre attention'));
  assert.ok(text.includes('Envoi'), 'le domaine en cause est nommé');
  assert.ok(text.includes('Aucun geste de reprise n’est proposé'));

  // Ce qu'elle ne doit surtout pas dire : aucune promesse d'action.
  for (const forbidden of ['reprise est disponible', 'action disponible', 'Les gestes de reprise']) {
    assert.equal(text.includes(forbidden), false, `affirmation trop forte : ${forbidden}`);
  }
});

test('42 · (C) run sain : aucune des deux phrases n’apparaît', async () => {
  const text = nextAction((await render(runView())).dom);
  assert.ok(text.includes('Transmettre la réponse'), 'le transfert reste principal');
  for (const forbidden of ['reprise est disponible', 'requiert votre attention']) {
    assert.equal(text.includes(forbidden), false);
  }
});

test('43 · un domaine actionnable et un domaine en conflit : la disponibilité prime, et ne nomme que ce qui est actionnable', async () => {
  const { dom } = await render(
    runView({
      run: {
        recovery: {
          step: { status: 'RESPONSE_NEEDS_FINALIZATION', available_actions: ['FINALIZE'], conflicts: [] },
          send: { status: 'EVIDENCE_CONFLICT', available_actions: [], conflicts: ['contradiction'] },
        },
      },
    }),
  );
  const text = nextAction(dom);
  assert.ok(text.includes('Une reprise est disponible'));
  // Le domaine sans geste n'est pas présenté comme actionnable.
  const line = text.slice(text.indexOf('Une reprise est disponible'), text.indexOf('Les gestes'));
  assert.ok(line.includes('Transfert'));
  assert.equal(line.includes('Envoi'), false, 'un domaine sans geste n’est pas annoncé comme disponible');
});

// ==========================================================================
// V2.3-S5P2 — header, compaction des actions, journal
// ==========================================================================

test('44–46 · le header parle en langage utilisateur, et ne suppose rien', async () => {
  // 44 · au tour de l'expert actif.
  const active = await render(runView({ run: { operational_state: { active_expert_slot: 'challenger' } } }));
  const line = textOf(active.dom.created.find((n) => n.attributes['class'] === 'run-situation') ?? null);
  assert.ok(line.includes('Tour 1'), line);
  assert.ok(line.includes('au tour de Challenger (Claude)'), line);
  assert.equal(line.includes('prochaine source'), false, 'le terme de spécification a quitté le header');
  assert.equal(line.includes('round'), false);
  assert.equal(/travaille|réfléchit|attend|tout va bien/.test(line), false, 'aucune supposition');

  // 45 · sinon, la dernière réponse — rôle puis moteur.
  //
  //      Le champ lu est `next_step_source_slot` : la SOURCE du prochain
  //      transfert, donc l'expert qui vient de répondre. Le nommer « prochain
  //      intervenant » désignait l'autre — et contredisait la carte d'action
  //      juste en dessous, qui proposait de transmettre SA réponse.
  const next = await render(runView());
  const nextLine = textOf(next.dom.created.find((n) => n.attributes['class'] === 'run-situation') ?? null);
  assert.ok(nextLine.includes('dernière réponse : Auteur (Codex)'), nextLine);
  assert.equal(nextLine.includes('prochain intervenant'), false, 'la source n’est pas le suivant');

  // 46 · fallback : ni expert actif, ni prochaine source — l'état autoritaire.
  const bare = await render(
    runView({ run: { operational_state: { active_expert_slot: null, next_step_source_slot: null, state: 'PAUSED' } } }),
  );
  const bareLine = textOf(bare.dom.created.find((n) => n.attributes['class'] === 'run-situation') ?? null);
  assert.ok(bareLine.includes('Tour 1'));
  assert.ok(bareLine.includes('Suspendu') || bareLine.includes('PAUSED'), bareLine);
});

test('47 · le mode devient un fait secondaire, hors de la phrase', async () => {
  const { dom } = await render(runView());
  const meta = textOf(dom.created.find((n) => n.attributes['class'] === 'run-situation-meta') ?? null);
  assert.ok(meta.includes('mode automatisé'), meta);
  const line = textOf(dom.created.find((n) => n.attributes['class'] === 'run-situation') ?? null);
  assert.equal(line.includes('automatisé'), false, 'le mode n’est plus au centre de la phrase');
});

test('48 · same-provider : le header garde les deux rôles distincts', async () => {
  const { dom } = await render(
    runView({
      run: {
        experts: { author: { provider: 'claude' }, challenger: { provider: 'claude' } },
        operational_state: { active_expert_slot: 'author' },
      },
    }),
  );
  const line = textOf(dom.created.find((n) => n.attributes['class'] === 'run-situation') ?? null);
  assert.ok(line.includes('au tour de Auteur (Claude)'), line);
});

test('49–51 · une seule action de rang 1, et le reste compacté', async () => {
  const { dom } = await render(runView());
  const workspaceText = workspace(dom);

  // 49 · une seule carte de prochaine étape.
  assert.equal(dom.created.filter((n) => n.attributes['class'] === 'next-action').length, 1);

  // 50 · STEP est l'action principale : sa grande carte ne se répète pas plus bas.
  const cards = dom.created.filter((n) => String(n.attributes['class'] ?? '') === 'card');
  const stepCards = cards.filter((n) => n.textContent.includes('Passage de témoin'));
  assert.equal(stepCards.length, 1, 'le transfert n’apparaît qu’une fois, au rang 1');

  // 51 · les trois groupes existent, et les limites sont repliées.
  for (const heading of ['Intervenir', 'Contrôles']) {
    assert.ok(workspaceText.includes(heading), `groupe ${heading}`);
  }
  const advanced = dom.created.find((n) => n.attributes['class'] === 'actions-unavailable');
  assert.ok(advanced !== undefined, 'le repli avancé existe');
  assert.equal(advanced?.tagName, 'DETAILS', 'accessible au clavier par nature');
  const advancedText = textOf(advanced ?? null);
  assert.ok(advancedText.includes('Autres actions et limites'));
  assert.ok(advancedText.includes('Handoff'));
  assert.ok(advancedText.includes('Décision'));
  assert.ok(advancedText.includes('Arrêt'));
});

test('52 · un transfert refusé garde son motif, dans le repli', async () => {
  const { dom } = await render(
    runView({ run: { operations: { step: { allowed: false, source_status: 'MISSING' } } } }),
  );
  const advanced = dom.created.find((n) => n.attributes['class'] === 'actions-unavailable');
  const text = textOf(advanced ?? null);
  assert.ok(text.includes('Passage de témoin'), 'le transfert refusé reste consultable');
  assert.ok(text.includes('aucune réponse transférable'), 'son motif est traduit');
});

test('53 · SEND principal : un chemin explicite vers le composeur', async () => {
  const { dom } = await render(
    runView({
      run: {
        operations: {
          step: { allowed: false, source_status: 'MISSING' },
          experts: { author: { send: { allowed: true } } },
        },
      },
    }),
  );
  const card = dom.created.find((n) => n.attributes['class'] === 'next-action');
  assert.ok(textOf(card ?? null).includes('Écrire à Auteur — Codex'));
  const jump = dom.document.getElementById('goto-compose');
  assert.ok(jump !== null, 'un contrôle mène au composeur');
  // Le composeur reste unique : aucune seconde zone de saisie n'est créée.
  assert.equal(dom.created.filter((n) => n.tagName === 'TEXTAREA' && n.attributes['id'] === 'send-content').length, 1);
  assert.ok(workspace(dom).includes('Intervenir'));
});

// --------------------------------------------------------------------------
// U-01 · Signal d'existence d'une proposition, et accès direct
//
// Le parcours principal ne disait rien d'une proposition enregistrée : il
// fallait ouvrir `Inspect` et défiler près de quatre écrans pour l'apprendre.
// Le signal corrige cela **sans** créer d'obligation : une proposition qui
// existe peut être consultée, elle n'exige rien.
//
//   PROPOSITION DISPONIBLE  ≠  action requise  ≠  décision  ≠  priorité
//
// Il ne crée aucun état, ne duplique pas la proposition, et ne retire aucune
// capacité — le passage de témoin garde exactement son rang.
// --------------------------------------------------------------------------

/** Projection V5 minimale, de la forme que S12 sérialise. */
function reconciliations(proposals: number): Record<string, unknown> {
  const options = [{ option_id: 'opt_000001', content: 'formulation proposée' }];
  return {
    read_model_version: 1,
    availability: 'AVAILABLE',
    recorded_count: proposals,
    reconciliation_revision: `rcn-sha256:${'e'.repeat(64)}`,
    items: proposals === 0 ? [] : [{
      controversy_id: 'ctv_000001',
      recorded_acts: [],
      proposals: Array.from({ length: proposals }, (_unused, index) => ({
        entry_id: `rcn_00000${String(index + 1)}`,
        options,
      })),
      responses: [],
      scopes: [],
      closure_declarations: [],
      closure_withdrawal_declarations: [],
      supersession_relations: [],
      decision_currentness: [],
      closure_effect_currentness: [],
      current_decisions: [],
      historical_explicit_whole_scope_closure_declaration: false,
      current_all_entries_closure_coverage: false,
      disagreement_view: [],
      detections: [],
      attribution: [],
    }],
  };
}

async function renderWith(
  view: Record<string, unknown>,
  handlers: Record<string, unknown>,
): Promise<ReturnType<typeof createFakeDom>> {
  const { createDomView } = (await importWeb('render.js')) as {
    createDomView: (doc: unknown, handlers?: unknown, options?: unknown) => View;
  };
  const dom = createFakeDom([...SHELL_IDS]);
  const api = createDomView(dom.document, handlers);
  api['showRunView']?.(view);
  return dom;
}

const signalCards = (dom: ReturnType<typeof createFakeDom>): FakeNode[] =>
  dom.created.filter((n) => n.attributes['class'] === 'card proposal-signal');

test('U-01 · A — sans proposition, aucun signal n’est affiché', async () => {
  const { dom } = await render(runView({ reconciliations: reconciliations(0) }));
  assert.equal(signalCards(dom).length, 0, 'aucune proposition : aucun signal');
  assert.equal(workspace(dom).includes('proposition de réconciliation'), false);

  // Et pas davantage lorsque V5 ne regarde pas ce run : `NOT_AVAILABLE` n'est
  // pas « zéro proposition ».
  const absent = await render(runView({
    reconciliations: { read_model_version: 1, availability: 'NOT_AVAILABLE' },
  }));
  assert.equal(signalCards(absent.dom).length, 0);
});

test('U-01 · B — avec une proposition, le signal est visible dans le parcours principal', async () => {
  const { dom } = await render(runView({ reconciliations: reconciliations(1) }));
  const cards = signalCards(dom);
  assert.equal(cards.length, 1, 'un signal, et un seul');

  // Visible dans la vue principale, non dans un onglet à découvrir.
  assert.ok(workspace(dom).includes('Une proposition de réconciliation est disponible.'));
  assert.ok(textOf(cards[0] ?? null).includes('Voir la proposition'));
});

test('U-01 · C — le signal n’implique aucune obligation, aucune priorité', async () => {
  const { dom } = await render(runView({ reconciliations: reconciliations(1) }));
  const text = textOf(signalCards(dom)[0] ?? null);

  for (const forbidden of [
    'attend votre réponse',
    'action requise',
    'décision requise',
    'vous devez',
    'à traiter',
    'en attente',
    'prioritaire',
    'urgent',
    'recommandé',
  ]) {
    assert.equal(text.toLowerCase().includes(forbidden), false, `formulation interdite : ${forbidden}`);
  }
  // Ce qu'il dit, en revanche : une proposition ne décide rien.
  assert.ok(text.includes('Une proposition n’est pas une décision.'));
});

test('U-01 · D — « Voir la proposition » demande l’accès à la section existante', async () => {
  const calls: string[] = [];
  const dom = await renderWith(runView({ reconciliations: reconciliations(1) }), {
    onShowReconciliation: () => calls.push('reconciliation'),
  });
  const button = dom.created.find((n) => n.attributes['data-goto'] === 'reconciliation');
  assert.ok(button !== undefined, 'le signal porte un accès direct');
  for (const handler of button.listeners['click'] ?? []) handler();
  assert.deepEqual(calls, ['reconciliation']);

  // La cible existe dans le rendu, et elle est focalisable par programme.
  const anchor = dom.created.find((n) => n.attributes['id'] === 'reconciliation-anchor');
  assert.ok(anchor !== undefined, 'la section porte une ancre');
  assert.equal(anchor.attributes['tabindex'], '-1', 'focalisable sans entrer dans la tabulation');
});

test('U-01 · D bis — le câblage vise l’onglet existant, sans créer de route', async () => {
  const app = await executable('app.js');
  assert.ok(app.includes("showSection('runtime')"), 'ouvre l’onglet Inspect existant');
  assert.ok(app.includes("focusAnchor('reconciliation-anchor')"), 'vise la section existante');
  assert.ok(app.includes("showSection('overview')"), 'le retour vise Conversation');
  // Aucun onglet, aucune route, aucun écran nouveau.
  for (const forbidden of ['section-reconciliation', 'tab-reconciliation', 'api/reconciliation-view']) {
    assert.equal(app.includes(forbidden), false, `surface nouvelle : ${forbidden}`);
  }
});

test('U-01 · E — la proposition n’est copiée nulle part', async () => {
  const { dom } = await render(runView({ reconciliations: reconciliations(1) }));

  // Une seule surface de réconciliation dans tout le document.
  assert.equal(dom.created.filter((n) => n.attributes['class'] === 'reconciliation').length, 1);
  // Le contenu de l'option ne fuit pas dans le parcours principal.
  assert.equal(workspace(dom).includes('formulation proposée'), false, 'aucune copie du contenu');
  // Et aucun geste humain n'apparaît hors de la section.
  assert.equal(workspace(dom).includes('Accepter (réponse)'), false, 'aucun geste dans la vue principale');
});

test('U-01 · F — « Retour à Conversation » revient, et ne mute rien', async () => {
  const calls: string[] = [];
  const mutations: string[] = [];
  const dom = await renderWith(runView({ reconciliations: reconciliations(1) }), {
    onShowConversation: () => calls.push('conversation'),
    onMutate: (action: unknown) => mutations.push(String(action)),
    onReconcile: (request: unknown) => mutations.push(JSON.stringify(request)),
  });
  const back = dom.created.find((n) => n.attributes['data-goto'] === 'conversation');
  assert.ok(back !== undefined, 'un retour local existe');
  for (const handler of back.listeners['click'] ?? []) handler();
  assert.deepEqual(calls, ['conversation']);
  assert.deepEqual(mutations, [], 'aucune donnée touchée par un retour');
});

test('U-01 · G+H — le passage de témoin garde son rang, aucune capacité n’est retirée', async () => {
  const withProposal = await render(runView({ reconciliations: reconciliations(1) }));
  const without = await render(runView({ reconciliations: reconciliations(0) }));

  // G · le transfert reste offert selon ses propres règles, proposition ou non.
  const step = (dom: ReturnType<typeof createFakeDom>): boolean =>
    dom.created.some((n) => n.attributes['data-action'] === 'STEP');
  assert.equal(step(withProposal.dom), step(without.dom), 'la proposition ne change pas l’offre de transfert');
  assert.ok(nextAction(withProposal.dom).length > 0, 'la carte de prochaine action subsiste');

  // H · aucune règle nouvelle ne bloque quoi que ce soit : les mêmes gestes
  // sont proposés dans les deux cas.
  const actions = (dom: ReturnType<typeof createFakeDom>): string[] =>
    dom.created
      .filter((n) => n.attributes['data-action'] !== undefined)
      .map((n) => String(n.attributes['data-action']))
      .sort();
  assert.deepEqual(actions(withProposal.dom), actions(without.dom));

  // Et le signal ne se substitue pas à la prochaine action : les deux coexistent.
  assert.equal(signalCards(withProposal.dom).length, 1);
  assert.equal(signalCards(without.dom).length, 0);
});
