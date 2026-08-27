/**
 * V2.2-IMP-11 — fondation du catalogue tarifaire versionné.
 *
 * Ce slice ne calcule **aucun** coût. Il établit ce qu'une règle tarifaire est,
 * et trois propriétés dont le futur estimateur dépendra entièrement.
 *
 *  1. **Les catégories appartiennent à un moteur.** Claude exclut le cache de
 *     son `input_tokens` là où Codex l'y inclut : une règle qui tariferait le
 *     compteur de l'autre appliquerait un prix à une sémantique étrangère.
 *  2. **Zéro n'est pas l'absence.** Un taux nul dit « connu, et gratuit » ; un
 *     taux manquant dit « cette règle ne sait pas traiter cette catégorie ».
 *  3. **Une version est un instantané.** Publier la suivante n'écrase jamais la
 *     précédente, qui reste vérifiable.
 *
 * ## Aucun tarif réel
 *
 * Toutes les valeurs de ce fichier sont **synthétiques** et servent uniquement
 * à éprouver la validation. Les modèles sont nommés `fixture-*`, les versions
 * `TEST-*`, la provenance `TEST_FIXTURE_ONLY`. Aucun nombre ici ne décrit le
 * tarif d'un fournisseur réel, et aucun n'a été recherché.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { isCcrError } from '../../src/core/errors.ts';
import {
  PRICING_CATALOG_SCHEMA_VERSION,
  PRICING_CATEGORIES,
  findPricingRule,
  validatePricingCatalog,
} from '../../src/core/pricing-catalog.ts';
import {
  pricingCatalogPaths,
  pricingCatalogVersionPath,
  readCurrentPricingCatalog,
  readPricingCatalogVersion,
} from '../../src/store/pricing-catalog-store.ts';
import { CCR_ROOT } from '../../src/store/layout.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

/** Provenance de test, jamais une source tarifaire. */
const TEST_SOURCE = {
  identifier: 'TEST_FIXTURE_ONLY',
  reference: 'TEST_FIXTURE_ONLY',
  declared_at: '2026-08-12T00:00:00.000Z',
};

/** Catalogue synthétique. Aucun de ces nombres n'est un tarif. */
function fixtureCatalog(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: PRICING_CATALOG_SCHEMA_VERSION,
    catalog_version: 'TEST-V1',
    currency: 'XTS',
    source: { ...TEST_SOURCE },
    entries: [
      {
        provider: 'claude',
        model: 'fixture-claude-model',
        usage_category: 'input_tokens',
        rate: '0.5',
        unit_scale: 1000,
      },
    ],
    ...over,
  };
}

function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: 'claude',
    model: 'fixture-claude-model',
    usage_category: 'input_tokens',
    rate: '1.25',
    unit_scale: 1,
    ...over,
  };
}

function expectInvalid(action: () => unknown, what: string): void {
  assert.throws(
    action,
    (error: unknown) => isCcrError(error) && error.code === 'PRICING_CATALOG_INVALID',
    what,
  );
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** Dépôt factice portant l'arborescence tarifaire. */
async function repo(prefix: string): Promise<{ root: string; write(version: string, doc: unknown): Promise<void>; select(doc: unknown): Promise<void>; cleanup(): Promise<void> }> {
  const root = await makeTempDir(prefix);
  const paths = pricingCatalogPaths(root);
  await mkdir(paths.catalogsDir, { recursive: true });
  return {
    root,
    async write(version, doc): Promise<void> {
      await writeFile(path.join(paths.catalogsDir, `${version}.json`), `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    },
    async select(doc): Promise<void> {
      await writeFile(paths.current, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    },
    cleanup: () => removeTempDir(root),
  };
}

// ==========================================================================
// A. Schéma
// ==========================================================================

test('1–8 · un catalogue synthétique valide, et ce qui le rend invalide', () => {
  // 1 · la forme complète.
  const catalog = validatePricingCatalog(fixtureCatalog());
  assert.equal(catalog.catalog_version, 'TEST-V1');
  assert.equal(catalog.currency, 'XTS');
  assert.deepEqual(catalog.source, TEST_SOURCE);
  assert.equal(catalog.entries.length, 1);

  // 2 · schéma inconnu, ou non entier.
  for (const version of [2, 0, '1', 1.5, undefined]) {
    expectInvalid(
      () => validatePricingCatalog(fixtureCatalog({ schema_version: version })),
      `schema_version ${String(version)}`,
    );
  }

  // 3 · version vide, absente, ou dangereuse pour un chemin.
  for (const version of ['', '   ', undefined, 42, '../evasion', 'a/b', '.', '..', '.hidden']) {
    expectInvalid(
      () => validatePricingCatalog(fixtureCatalog({ catalog_version: version })),
      `catalog_version ${String(version)}`,
    );
  }

  // 4 · provenance manquante, incomplète, ou ouverte.
  expectInvalid(() => validatePricingCatalog(fixtureCatalog({ source: undefined })), 'source absente');
  for (const field of ['identifier', 'reference', 'declared_at']) {
    const partial: Record<string, unknown> = { ...TEST_SOURCE };
    delete partial[field];
    expectInvalid(
      () => validatePricingCatalog(fixtureCatalog({ source: partial })),
      `source sans ${field}`,
    );
  }
  expectInvalid(
    () => validatePricingCatalog(fixtureCatalog({ source: { ...TEST_SOURCE, note: 'libre' } })),
    'la provenance n’est pas un sac JSON',
  );
  expectInvalid(
    () => validatePricingCatalog(fixtureCatalog({ source: { ...TEST_SOURCE, declared_at: 'un jour' } })),
    'une date illisible',
  );

  // 5 · devise.
  for (const currency of ['usd', 'US', 'USDD', '', 3, 'US$']) {
    expectInvalid(
      () => validatePricingCatalog(fixtureCatalog({ currency })),
      `currency ${String(currency)}`,
    );
  }

  // 6 · champ étranger, à la racine comme dans une entrée.
  expectInvalid(
    () => validatePricingCatalog({ ...fixtureCatalog(), discount: 0.1 }),
    'aucune remise',
  );
  for (const foreign of ['tax', 'fx_rate', 'subscription_tier', 'provider_credits', 'quota']) {
    expectInvalid(
      () => validatePricingCatalog(fixtureCatalog({ entries: [{ ...entry(), [foreign]: 1 }] })),
      `aucun ${foreign}`,
    );
  }
  expectInvalid(
    () => validatePricingCatalog(fixtureCatalog({ entries: 'aucune' })),
    'entries doit être un tableau',
  );

  // 7 · fournisseur inconnu.
  for (const provider of ['groq', 'openai', '', undefined]) {
    expectInvalid(
      () => validatePricingCatalog(fixtureCatalog({ entries: [entry({ provider })] })),
      `provider ${String(provider)}`,
    );
  }

  // 8 · modèle vide, et aucun joker.
  for (const model of ['', '   ', undefined, 7]) {
    expectInvalid(
      () => validatePricingCatalog(fixtureCatalog({ entries: [entry({ model })] })),
      `model ${String(model)}`,
    );
  }
});

test('9–12 · les catégories appartiennent à leur moteur', () => {
  // 9 · 10 · chaque catégorie déclarée est acceptée chez elle.
  for (const [provider, categories] of Object.entries(PRICING_CATEGORIES)) {
    for (const category of categories) {
      const catalog = validatePricingCatalog(
        fixtureCatalog({
          entries: [
            entry({ provider, model: `fixture-${provider}-model`, usage_category: category }),
          ],
        }),
      );
      assert.equal(catalog.entries[0]?.usage_category, category);
    }
  }

  // 11 · une catégorie Codex sur Claude.
  for (const category of ['cached_input_tokens', 'cache_write_input_tokens', 'reasoning_output_tokens']) {
    expectInvalid(
      () =>
        validatePricingCatalog(
          fixtureCatalog({ entries: [entry({ provider: 'claude', usage_category: category })] }),
        ),
      `${category} n’existe pas chez Claude`,
    );
  }

  // 12 · une catégorie Claude sur Codex.
  for (const category of ['cache_creation_input_tokens', 'cache_read_input_tokens']) {
    expectInvalid(
      () =>
        validatePricingCatalog(
          fixtureCatalog({
            entries: [
              entry({ provider: 'codex', model: 'fixture-codex-model', usage_category: category }),
            ],
          }),
        ),
      `${category} n’existe pas chez Codex`,
    );
  }

  // Aucune catégorie générique n'est acceptée nulle part.
  for (const generic of ['total_tokens', 'all_input', 'all_output', 'tokens']) {
    expectInvalid(
      () => validatePricingCatalog(fixtureCatalog({ entries: [entry({ usage_category: generic })] })),
      `aucune catégorie ${generic}`,
    );
  }
});

// ==========================================================================
// B. Taux et échelle
// ==========================================================================

test('13–17 · le taux est une décimale canonique, et zéro en est une', () => {
  // 13 · 14 · zéro explicite, et une valeur positive synthétique.
  for (const rate of ['0', '0.0', '0.000001', '1.25', '12']) {
    const catalog = validatePricingCatalog(fixtureCatalog({ entries: [entry({ rate })] }));
    assert.equal(catalog.entries[0]?.rate, rate, 'conservé tel quel');
  }

  // 15 · 16 · 17 · tout le reste est refusé.
  for (const rate of [
    '-1',
    '+1',
    '1e-6',
    '1E6',
    '1,5',
    ' 1',
    '1 ',
    '.5',
    '1.',
    '',
    'NaN',
    'Infinity',
    '01',
    1.25,
    null,
  ]) {
    expectInvalid(
      () => validatePricingCatalog(fixtureCatalog({ entries: [entry({ rate })] })),
      `rate ${String(rate)}`,
    );
  }
});

test('18–22 · l’échelle est un entier strictement positif', () => {
  // 18 · 19 · formes valides, structurelles seulement.
  for (const scale of [1, 1000, 1000000]) {
    const catalog = validatePricingCatalog(fixtureCatalog({ entries: [entry({ unit_scale: scale })] }));
    assert.equal(catalog.entries[0]?.unit_scale, scale);
  }

  // 20 · 21 · 22 · zéro, négatif, décimal, non sûr, non nombre.
  for (const scale of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1000', undefined, Number.NaN]) {
    expectInvalid(
      () => validatePricingCatalog(fixtureCatalog({ entries: [entry({ unit_scale: scale })] })),
      `unit_scale ${String(scale)}`,
    );
  }
});

// ==========================================================================
// C. Unicité
// ==========================================================================

test('23–25 · une clé, un prix', () => {
  // 23 · le même triplet deux fois : contradiction, jamais préférence.
  expectInvalid(
    () =>
      validatePricingCatalog(
        fixtureCatalog({ entries: [entry({ rate: '1' }), entry({ rate: '2' })] }),
      ),
    'ni la première, ni la dernière, ni leur somme',
  );

  // 24 · deux catégories du même modèle.
  const twoCategories = validatePricingCatalog(
    fixtureCatalog({
      entries: [entry({ usage_category: 'input_tokens' }), entry({ usage_category: 'output_tokens' })],
    }),
  );
  assert.equal(twoCategories.entries.length, 2);

  // 25 · deux modèles, et deux moteurs.
  const twoModels = validatePricingCatalog(
    fixtureCatalog({
      entries: [
        entry({ model: 'fixture-claude-model' }),
        entry({ model: 'fixture-claude-model-2' }),
        entry({ provider: 'codex', model: 'fixture-codex-model' }),
      ],
    }),
  );
  assert.equal(twoModels.entries.length, 3);

  // La recherche d'une règle est exacte : aucun repli, aucun joker.
  assert.equal(
    findPricingRule(twoModels, 'claude', 'fixture-claude-model', 'input_tokens')?.rate,
    '1.25',
  );
  assert.equal(findPricingRule(twoModels, 'claude', 'fixture-inconnu', 'input_tokens'), undefined);
  assert.equal(
    findPricingRule(twoModels, 'codex', 'fixture-claude-model', 'input_tokens'),
    undefined,
    'le modèle d’un moteur ne vaut pas pour l’autre',
  );
});

// ==========================================================================
// D. Versions, sélecteur, absence
// ==========================================================================

test('26–27 · deux versions coexistent, et la sélection n’en modifie aucune', async () => {
  const r = await repo('ccr-pricing-versions-');
  try {
    const v1 = fixtureCatalog({ catalog_version: 'TEST-V1', entries: [entry({ rate: '1' })] });
    const v2 = fixtureCatalog({ catalog_version: 'TEST-V2', entries: [entry({ rate: '2' })] });
    await r.write('TEST-V1', v1);
    await r.write('TEST-V2', v2);
    const before = await readFile(
      path.join(pricingCatalogPaths(r.root).catalogsDir, 'TEST-V1.json'),
      'utf8',
    );

    await r.select({ schema_version: 1, catalog_version: 'TEST-V2' });
    const current = await readCurrentPricingCatalog(r.root);
    assert.equal(current.kind, 'CONFIGURED');
    if (current.kind !== 'CONFIGURED') throw new Error('configuré attendu');
    assert.equal(current.catalog.catalog_version, 'TEST-V2');
    assert.equal(current.catalog.entries[0]?.rate, '2');

    // 27 · l'ancienne version reste lisible, et intacte.
    const old = await readPricingCatalogVersion('TEST-V1', r.root);
    assert.equal(old?.catalog_version, 'TEST-V1');
    assert.equal(old?.entries[0]?.rate, '1');
    assert.equal(
      await readFile(path.join(pricingCatalogPaths(r.root).catalogsDir, 'TEST-V1.json'), 'utf8'),
      before,
      'aucun fichier historique réécrit',
    );

    // Un instantané qui ne se nomme pas lui-même ne peut pas être cité.
    await r.write('TEST-V3', fixtureCatalog({ catalog_version: 'TEST-AUTRE' }));
    await assert.rejects(
      readPricingCatalogVersion('TEST-V3', r.root),
      (error: unknown) => isCcrError(error) && error.code === 'PRICING_CATALOG_INVALID',
    );

    // Une version inexistante est introuvable — un fait, pas une panne.
    assert.equal(await readPricingCatalogVersion('TEST-ABSENTE', r.root), undefined);
  } finally {
    await r.cleanup();
  }
});

test('28–31 · absence, sélecteur corrompu, version citée manquante', async () => {
  // 28 · le dépôt de production, tel qu'il est après ce slice.
  assert.deepEqual(await readCurrentPricingCatalog(CCR_ROOT), { kind: 'NONE' });
  assert.equal(await exists(pricingCatalogPaths(CCR_ROOT).current), false);

  const r = await repo('ccr-pricing-current-');
  try {
    // Aucun sélecteur : absence, jamais erreur.
    assert.deepEqual(await readCurrentPricingCatalog(r.root), { kind: 'NONE' });

    // 30 · sélecteur illisible ou mal formé.
    await writeFile(pricingCatalogPaths(r.root).current, '{ pas du JSON', 'utf8');
    await assert.rejects(
      readCurrentPricingCatalog(r.root),
      (error: unknown) => isCcrError(error) && error.code === 'PRICING_CATALOG_INVALID',
    );
    for (const selector of [
      { schema_version: 2, catalog_version: 'TEST-V1' },
      { schema_version: 1 },
      { schema_version: 1, catalog_version: '../evasion' },
      { schema_version: 1, catalog_version: 'TEST-V1', note: 'libre' },
      [],
    ]) {
      await r.select(selector);
      await assert.rejects(
        readCurrentPricingCatalog(r.root),
        (error: unknown) => isCcrError(error) && error.code === 'PRICING_CATALOG_INVALID',
        JSON.stringify(selector),
      );
    }

    // 31 · le sélecteur cite une version absente : erreur, jamais NONE.
    await r.select({ schema_version: 1, catalog_version: 'TEST-ABSENTE' });
    const error = await readCurrentPricingCatalog(r.root).catch((e: unknown) => e);
    assert.ok(isCcrError(error) && error.code === 'PRICING_CATALOG_READ_FAILED');
    assert.notEqual(error.code, 'PRICING_CATALOG_INVALID');

    // Un catalogue cité mais corrompu ne devient pas NONE non plus.
    await r.write('TEST-CORROMPU', { schema_version: 1 });
    await r.select({ schema_version: 1, catalog_version: 'TEST-CORROMPU' });
    await assert.rejects(
      readCurrentPricingCatalog(r.root),
      (err: unknown) => isCcrError(err) && err.code === 'PRICING_CATALOG_INVALID',
    );
  } finally {
    await r.cleanup();
  }
});

test('32 · lire ne crée rien, et aucun chemin ne s’évade', async () => {
  const r = await repo('ccr-pricing-readonly-');
  try {
    const paths = pricingCatalogPaths(r.root);
    await readCurrentPricingCatalog(r.root);
    await readPricingCatalogVersion('TEST-ABSENTE', r.root).catch(() => undefined);
    assert.equal(await exists(paths.current), false, 'aucun sélecteur fabriqué');

    // La version participe à un nom de fichier : le confinement est vérifié
    // après résolution, pas seulement par la forme.
    for (const version of ['../evasion', 'a/b', '..', '.', 'a\\b']) {
      assert.equal(pricingCatalogVersionPath(paths, version), undefined, version);
    }
    const legitimate = pricingCatalogVersionPath(paths, 'TEST-V1');
    assert.ok(legitimate?.startsWith(path.resolve(paths.catalogsDir) + path.sep));
  } finally {
    await r.cleanup();
  }
});

// ==========================================================================
// E. Précision et frontières
// ==========================================================================

test('33 · une décimale fine traverse la validation sans être convertie', () => {
  // Valeur SYNTHÉTIQUE : elle éprouve la représentation, pas un tarif.
  const catalog = validatePricingCatalog(fixtureCatalog({ entries: [entry({ rate: '0.000001' })] }));
  const rate = catalog.entries[0]?.rate;
  assert.equal(rate, '0.000001');
  assert.equal(typeof rate, 'string', 'jamais un number');

  // Le passage par un flottant binaire ne serait pas fidèle : la garde est là
  // pour que le futur estimateur parte d'un chiffre exact.
  assert.notEqual(String(Number('0.1') + Number('0.2')), '0.3');
  assert.equal(catalog.entries[0]?.rate.length, '0.000001'.length);
});

test('34 · aucun tarif réel n’est embarqué', async () => {
  const paths = pricingCatalogPaths(CCR_ROOT);
  // Ni sélecteur, ni répertoire de catalogues : CCR n'affirme aucun prix.
  assert.equal(await exists(paths.current), false);
  assert.equal(await exists(paths.catalogsDir), false);
  assert.deepEqual(await readCurrentPricingCatalog(CCR_ROOT), { kind: 'NONE' });
});

test('35 · gardes : hors ligne, sans usage, sans quota, sans estimateur', async () => {
  const executable = async (relative: string): Promise<string> => {
    const raw = await readFile(new URL(`../../src/${relative}`, import.meta.url), 'utf8');
    return raw
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
  };

  for (const relative of ['core/pricing-catalog.ts', 'store/pricing-catalog-store.ts']) {
    const code = await executable(relative);
    // Aucun réseau, aucune dépendance externe.
    for (const forbidden of ['fetch', 'http', 'https', 'ccusage', 'undici', 'axios']) {
      assert.equal(code.includes(forbidden), false, `${relative} sans ${forbidden}`);
    }
    // Le catalogue décrit des règles, jamais des observations.
    for (const forbidden of [
      'usage-read-model',
      'usage-ledger',
      'invocation-ledger',
      'invocation-policy',
      'invocation-quota',
    ]) {
      assert.equal(code.includes(forbidden), false, `${relative} ignore ${forbidden}`);
    }
    // Aucune mutation exposée : une évolution passe par le dépôt.
    for (const forbidden of ['updateCatalog', 'createCatalog', 'replaceCatalog', 'writeFile', 'appendJson']) {
      assert.equal(code.includes(forbidden), false, `${relative} sans ${forbidden}`);
    }
    // Aucun calcul.
    for (const forbidden of ['estimate', 'Estimate', 'amount', 'budget']) {
      assert.equal(code.includes(forbidden), false, `${relative} ne calcule rien (${forbidden})`);
    }
  }

  // Aucun estimateur n'a été ajouté, et le read model d'usage est intact.
  const usage = await executable('services/usage-read-model.ts');
  assert.equal(usage.includes('pricing'), false, 'IMP-10 ignore le catalogue');
  for (const relative of ['cli/main.ts', 'cockpit/mutations-http.ts', 'cockpit/server.ts']) {
    const code = await executable(relative);
    for (const forbidden of ['pricing', 'Pricing', 'catalog', 'Catalog']) {
      assert.equal(code.includes(forbidden), false, `${relative} n’expose pas ${forbidden}`);
    }
  }
});
