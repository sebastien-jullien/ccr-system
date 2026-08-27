/**
 * Tests unitaires du schéma de configuration CCR (lot V1.1-1, spécification
 * V1.1 §11, §13.1, §21).
 *
 * Ces tests portent sur des fonctions pures : validation stricte, observation
 * de la variable historique et calcul de la configuration effective. Aucun
 * accès disque, aucun fournisseur.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONFIG_SCHEMA_VERSION,
  LEGACY_SKIP_GIT_REPO_CHECK_ENV,
  defaultConfig,
  observeLegacyEnv,
  resolveEffectiveConfig,
  validateConfig,
} from '../../src/config/config-schema.ts';
import type { CcrConfig, LoadedConfig } from '../../src/config/config-schema.ts';
import { isCcrError } from '../../src/core/errors.ts';
import type { CcrErrorCode } from '../../src/core/errors.ts';

const VALID = {
  schema_version: 1,
  preflight: { offer_interactive_login: true },
  codex: { skip_git_repo_check: false },
};

function expectRejected(value: unknown, code: CcrErrorCode, what: string): void {
  try {
    validateConfig(value);
  } catch (error) {
    assert.ok(isCcrError(error), `${what} : attendu une CcrError, reçu ${String(error)}`);
    assert.equal(error.code, code, what);
    return;
  }
  assert.fail(`${what} : attendu ${code}, aucune erreur levée`);
}

function loaded(config: CcrConfig, origin: 'file' | 'defaults'): LoadedConfig {
  return { config, origin, path: '/injecté/config.json' };
}

// --------------------------------------------------------------------------
// Défauts et document valide
// --------------------------------------------------------------------------

test('les valeurs par défaut sont celles de la spécification §11.2', () => {
  const defaults = defaultConfig();

  assert.equal(defaults.schema_version, CONFIG_SCHEMA_VERSION);
  assert.equal(defaults.preflight.offer_interactive_login, true);
  // Le contournement Codex est opt-in : jamais activé silencieusement.
  assert.equal(defaults.codex.skip_git_repo_check, false);
  assert.deepEqual(validateConfig(defaults), defaults, 'le document par défaut est lui-même valide');
});

test('(2) un document valide est accepté tel quel, sans champ ajouté', () => {
  const config = validateConfig({
    schema_version: 1,
    preflight: { offer_interactive_login: false },
    codex: { skip_git_repo_check: true },
  });

  assert.deepEqual(config, {
    schema_version: 1,
    preflight: { offer_interactive_login: false },
    codex: { skip_git_repo_check: true },
  });
  assert.deepEqual(Object.keys(config).sort(), ['codex', 'preflight', 'schema_version']);
});

// --------------------------------------------------------------------------
// Schéma
// --------------------------------------------------------------------------

test('(4) une schema_version inconnue est refusée en CONFIG_SCHEMA_UNSUPPORTED', () => {
  expectRejected({ ...VALID, schema_version: 2 }, 'CONFIG_SCHEMA_UNSUPPORTED', 'version future');
  expectRejected({ ...VALID, schema_version: 0 }, 'CONFIG_SCHEMA_UNSUPPORTED', 'version nulle');
  expectRejected({ ...VALID, schema_version: 1.5 }, 'CONFIG_SCHEMA_UNSUPPORTED', 'version non entière');
});

test('(4/6) une schema_version mal typée est une erreur de document, pas une version', () => {
  // `"1"` ne devient jamais `1` : c'est un document invalide, pas une version
  // inconnue. La distinction compte pour le futur message de `doctor`.
  expectRejected({ ...VALID, schema_version: '1' }, 'CONFIG_INVALID', 'version en chaîne');
  expectRejected({ ...VALID, schema_version: null }, 'CONFIG_INVALID', 'version nulle explicite');
  const { schema_version: _omitted, ...sansVersion } = VALID;
  expectRejected(sansVersion, 'CONFIG_INVALID', 'version absente');
});

// --------------------------------------------------------------------------
// Types et coercitions
// --------------------------------------------------------------------------

test('(5) un mauvais type de valeur est refusé', () => {
  expectRejected(
    { ...VALID, codex: { skip_git_repo_check: 'yes' } },
    'CONFIG_INVALID',
    'exemple explicite de la spécification §21',
  );
  expectRejected(
    { ...VALID, preflight: { offer_interactive_login: 'no' } },
    'CONFIG_INVALID',
    'préflight mal typé',
  );
});

test('(6) aucune coercition implicite n\'est appliquée', () => {
  for (const forme of ['true', 'false', '1', '0', 1, 0, null, [], {}]) {
    expectRejected(
      { ...VALID, codex: { skip_git_repo_check: forme } },
      'CONFIG_INVALID',
      `codex.skip_git_repo_check = ${JSON.stringify(forme)}`,
    );
    expectRejected(
      { ...VALID, preflight: { offer_interactive_login: forme } },
      'CONFIG_INVALID',
      `preflight.offer_interactive_login = ${JSON.stringify(forme)}`,
    );
  }
});

test('un document non objet est refusé', () => {
  expectRejected(null, 'CONFIG_INVALID', 'null');
  expectRejected([VALID], 'CONFIG_INVALID', 'tableau');
  expectRejected('{}', 'CONFIG_INVALID', 'chaîne');
  expectRejected(42, 'CONFIG_INVALID', 'nombre');
});

test('un document partiel est refusé, jamais complété par les défauts', () => {
  // Les valeurs par défaut couvrent l'absence de fichier (§11.2), pas l'absence
  // d'un champ dans un fichier existant : compléter en silence reviendrait à
  // deviner l'intention de l'utilisateur.
  expectRejected({ schema_version: 1 }, 'CONFIG_INVALID', 'sections absentes');
  expectRejected({ schema_version: 1, preflight: {}, codex: {} }, 'CONFIG_INVALID', 'sections vides');
  expectRejected(
    { schema_version: 1, codex: { skip_git_repo_check: true } },
    'CONFIG_INVALID',
    'préflight absent',
  );
  expectRejected(
    { schema_version: 1, preflight: { offer_interactive_login: true } },
    'CONFIG_INVALID',
    'section codex absente',
  );
});

test('une clé inconnue est refusée plutôt qu\'ignorée en silence', () => {
  // Une faute de frappe — `skip_git_repo_checks` — serait sans effet et
  // laisserait croire au contraire.
  expectRejected({ ...VALID, extra: true }, 'CONFIG_INVALID', 'clé racine inconnue');
  expectRejected(
    { ...VALID, codex: { skip_git_repo_check: true, skip_git_repo_checks: true } },
    'CONFIG_INVALID',
    'clé de section inconnue',
  );
});

// --------------------------------------------------------------------------
// Variable historique — table de vérité §13.1
// --------------------------------------------------------------------------

test('(12) la variable historique exactement "1" demande le contournement', () => {
  const observation = observeLegacyEnv({ [LEGACY_SKIP_GIT_REPO_CHECK_ENV]: '1' });

  assert.equal(observation.present, true);
  assert.equal(observation.canonical, true);
  assert.equal(observation.nonCanonical, false);
});

test('(13/14/15/17) toute autre valeur présente vaut false, sans erreur', () => {
  for (const value of ['0', 'true', 'TRUE', 'yes', '', 'on', ' 1', '1 ']) {
    const observation = observeLegacyEnv({ [LEGACY_SKIP_GIT_REPO_CHECK_ENV]: value });

    assert.equal(observation.present, true, `présente pour ${JSON.stringify(value)}`);
    assert.equal(observation.canonical, false, `non canonique pour ${JSON.stringify(value)}`);
    // Identifiable pour le futur avertissement de `ccr doctor` (§30)…
    assert.equal(observation.nonCanonical, true, `signalable pour ${JSON.stringify(value)}`);
  }
});

test('la valeur brute de la variable historique n\'est jamais conservée', () => {
  const observation = observeLegacyEnv({ [LEGACY_SKIP_GIT_REPO_CHECK_ENV]: 'valeur-sensible' });

  assert.ok(!JSON.stringify(observation).includes('valeur-sensible'));
});

test('(11) la variable historique absente laisse la main à la configuration', () => {
  const observation = observeLegacyEnv({});

  assert.equal(observation.present, false);
  assert.equal(observation.canonical, false);
  assert.equal(observation.nonCanonical, false);
});

// --------------------------------------------------------------------------
// Configuration effective
// --------------------------------------------------------------------------

test('(11/16) sans variable historique, la configuration utilisateur décide', () => {
  const config: CcrConfig = { ...defaultConfig(), codex: { skip_git_repo_check: true } };
  const effective = resolveEffectiveConfig(loaded(config, 'file'), {});

  assert.equal(effective.codex.skipGitRepoCheck, true);
  assert.equal(effective.codex.source, 'config');
  assert.equal(effective.preflight.source, 'config');
});

test('(16) sans fichier ni variable, la source effective est le défaut', () => {
  const effective = resolveEffectiveConfig(loaded(defaultConfig(), 'defaults'), {});

  assert.equal(effective.codex.skipGitRepoCheck, false);
  assert.equal(effective.codex.source, 'default');
  assert.equal(effective.preflight.offerInteractiveLogin, true);
  assert.equal(effective.preflight.source, 'default');
  assert.equal(effective.configOrigin, 'defaults');
});

test('(12/16) la variable historique canonique prime sur la configuration', () => {
  const config: CcrConfig = { ...defaultConfig(), codex: { skip_git_repo_check: false } };
  const effective = resolveEffectiveConfig(loaded(config, 'file'), {
    [LEGACY_SKIP_GIT_REPO_CHECK_ENV]: '1',
  });

  assert.equal(effective.codex.skipGitRepoCheck, true);
  assert.equal(effective.codex.source, 'legacy-env');
});

test('(13/14/15) une variable présente non canonique décide false et n\'interroge pas la configuration', () => {
  const config: CcrConfig = { ...defaultConfig(), codex: { skip_git_repo_check: true } };

  for (const value of ['0', 'true', 'yes', '']) {
    const effective = resolveEffectiveConfig(loaded(config, 'file'), {
      [LEGACY_SKIP_GIT_REPO_CHECK_ENV]: value,
    });

    // La configuration dit `true` ; la variable est présente, donc elle décide.
    assert.equal(effective.codex.skipGitRepoCheck, false, `valeur ${JSON.stringify(value)}`);
    assert.equal(effective.codex.source, 'legacy-env');
    assert.equal(effective.legacyEnv.nonCanonical, true);
  }
});

test('la variable historique ne gouverne jamais le préflight', () => {
  const config: CcrConfig = { ...defaultConfig(), preflight: { offer_interactive_login: false } };
  const effective = resolveEffectiveConfig(loaded(config, 'file'), {
    [LEGACY_SKIP_GIT_REPO_CHECK_ENV]: '1',
  });

  assert.equal(effective.preflight.offerInteractiveLogin, false);
  assert.equal(effective.preflight.source, 'config');
});

test('la résolution effective reproduit exactement le comportement V1 de deps.ts', () => {
  // V1 calcule : `process.env['CCR_CODEX_SKIP_GIT_REPO_CHECK'] === '1'`.
  // La V1.1 doit produire le même booléen dès que la variable est présente.
  const config: CcrConfig = { ...defaultConfig(), codex: { skip_git_repo_check: true } };

  for (const value of ['1', '0', 'true', 'yes', '', '11', '1 ']) {
    const env = { [LEGACY_SKIP_GIT_REPO_CHECK_ENV]: value };
    const v1 = env[LEGACY_SKIP_GIT_REPO_CHECK_ENV] === '1';
    const v11 = resolveEffectiveConfig(loaded(config, 'file'), env).codex.skipGitRepoCheck;

    assert.equal(v11, v1, `divergence pour ${JSON.stringify(value)}`);
  }
});
