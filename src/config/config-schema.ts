/**
 * Schéma de la configuration locale CCR (spécification V1.1, §11, §13, §21).
 *
 * Ce module est **pur** : aucune entrée/sortie, aucune connaissance du disque,
 * aucune connaissance des fournisseurs. Il définit trois choses :
 *
 *  - le document persistant `~/.ccr/config.json` et ses valeurs par défaut ;
 *  - sa validation stricte, sans aucune coercition de type ;
 *  - la résolution de la configuration **effective**, c'est-à-dire la
 *    combinaison `variable legacy → configuration → défaut` (§13.1).
 *
 * Deux notions distinctes, à ne jamais confondre :
 *
 *   CcrConfig        ce qui est écrit sur le disque
 *   EffectiveConfig  ce que CCR applique réellement, avec la provenance de
 *                    chaque valeur
 *
 * La provenance est conservée parce que `ccr doctor` devra plus tard expliquer
 * *pourquoi* une valeur s'applique. Elle n'est ni persistée, ni décisionnelle
 * ici.
 */

import { CcrError } from '../core/errors.ts';

// --------------------------------------------------------------------------
// Document persistant
// --------------------------------------------------------------------------

export const CONFIG_SCHEMA_VERSION = 1;

/** Versions de `config.json` que cette version de CCR sait lire. */
export const SUPPORTED_CONFIG_SCHEMA_VERSIONS: readonly number[] = [1];

export interface CcrConfig {
  readonly schema_version: number;
  readonly preflight: {
    /** Autorise `setup`/`start` à proposer une connexion interactive (§17.3). */
    readonly offer_interactive_login: boolean;
  };
  readonly codex: {
    /**
     * Paramètre d'invocation de Codex, et rien d'autre (§12) : il autorise
     * `codex exec` hors dépôt Git. Il n'affaiblit aucune permission.
     */
    readonly skip_git_repo_check: boolean;
  };
}

/**
 * Valeurs appliquées en l'absence totale de configuration (§11.2).
 *
 * Le contournement Codex reste `false` : il est opt-in et n'est jamais activé
 * silencieusement.
 */
export function defaultConfig(): CcrConfig {
  return {
    schema_version: CONFIG_SCHEMA_VERSION,
    preflight: { offer_interactive_login: true },
    codex: { skip_git_repo_check: false },
  };
}

// --------------------------------------------------------------------------
// Validation stricte
// --------------------------------------------------------------------------

const ROOT_KEYS: readonly string[] = ['schema_version', 'preflight', 'codex'];
const PREFLIGHT_KEYS: readonly string[] = ['offer_interactive_login'];
const CODEX_KEYS: readonly string[] = ['skip_git_repo_check'];

/** Nom de type lisible, sans jamais recopier la valeur observée. */
function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function invalid(message: string, details: Readonly<Record<string, unknown>>): CcrError {
  return new CcrError('CONFIG_INVALID', message, { details });
}

function asObject(value: unknown, at: string): Record<string, unknown> {
  if (value === undefined) {
    throw invalid(`Configuration CCR : section « ${at} » absente.`, { at, expected: 'object' });
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(`Configuration CCR : « ${at} » doit être un objet JSON.`, {
      at,
      expected: 'object',
      received: typeName(value),
    });
  }
  return value as Record<string, unknown>;
}

/**
 * Lit un booléen strict.
 *
 * Aucune coercition n'est tolérée (§21) : `"true"`, `1`, `"1"` et `"yes"` sont
 * des erreurs, pas des synonymes de `true`. Une configuration ambiguë doit être
 * corrigée par un humain, jamais devinée par CCR.
 */
function requireBoolean(section: Record<string, unknown>, key: string, at: string): boolean {
  const value = section[key];
  if (value === undefined) {
    throw invalid(`Configuration CCR : « ${at} » est obligatoire.`, { at, expected: 'boolean' });
  }
  if (typeof value !== 'boolean') {
    throw invalid(
      `Configuration CCR : « ${at} » doit être un booléen JSON (true/false). ` +
        'Aucune conversion implicite n\'est appliquée.',
      { at, expected: 'boolean', received: typeName(value) },
    );
  }
  return value;
}

function rejectUnknownKeys(record: Record<string, unknown>, known: readonly string[], at: string): void {
  const unknown = Object.keys(record).filter((key) => !known.includes(key));
  if (unknown.length === 0) return;
  throw invalid(
    `Configuration CCR : clé${unknown.length > 1 ? 's' : ''} inconnue${unknown.length > 1 ? 's' : ''} ` +
      `dans « ${at} » : ${unknown.join(', ')}. Une clé non reconnue serait sans effet silencieux.`,
    { at, unknown, known: [...known] },
  );
}

/**
 * Valide un document de configuration.
 *
 * Rappel de doctrine : l'incertitude ne devient jamais un succès. Un document
 * partiel, mal typé ou porteur d'une clé inconnue est refusé, jamais complété
 * par des valeurs par défaut. Les défauts s'appliquent à l'**absence de
 * fichier** (§11.2), pas à l'absence d'un champ dans un fichier existant.
 */
export function validateConfig(value: unknown): CcrConfig {
  const record = asObject(value, 'config.json');
  rejectUnknownKeys(record, ROOT_KEYS, 'config.json');

  const version = record['schema_version'];
  if (version === undefined) {
    throw invalid('Configuration CCR : « schema_version » est obligatoire.', {
      at: 'schema_version',
      expected: 'number',
    });
  }
  if (typeof version !== 'number') {
    // Un type erroné est une erreur de document, pas une version inconnue :
    // `"1"` ne devient jamais `1`.
    throw invalid('Configuration CCR : « schema_version » doit être un nombre JSON.', {
      at: 'schema_version',
      expected: 'number',
      received: typeName(version),
    });
  }
  if (!SUPPORTED_CONFIG_SCHEMA_VERSIONS.includes(version)) {
    throw new CcrError(
      'CONFIG_SCHEMA_UNSUPPORTED',
      `Configuration CCR : schema_version ${String(version)} non supportée par cette version de CCR.`,
      { details: { found: version, supported: [...SUPPORTED_CONFIG_SCHEMA_VERSIONS] } },
    );
  }

  const preflight = asObject(record['preflight'], 'preflight');
  rejectUnknownKeys(preflight, PREFLIGHT_KEYS, 'preflight');

  const codex = asObject(record['codex'], 'codex');
  rejectUnknownKeys(codex, CODEX_KEYS, 'codex');

  return {
    schema_version: version,
    preflight: {
      offer_interactive_login: requireBoolean(
        preflight,
        'offer_interactive_login',
        'preflight.offer_interactive_login',
      ),
    },
    codex: {
      skip_git_repo_check: requireBoolean(codex, 'skip_git_repo_check', 'codex.skip_git_repo_check'),
    },
  };
}

// --------------------------------------------------------------------------
// Variable d'environnement historique (§13.1)
// --------------------------------------------------------------------------

export const LEGACY_SKIP_GIT_REPO_CHECK_ENV = 'CCR_CODEX_SKIP_GIT_REPO_CHECK';

/** Seule valeur qui active le contournement, en comparaison stricte. */
export const LEGACY_SKIP_GIT_REPO_CHECK_CANONICAL = '1';

/**
 * Observation de la variable historique, sans jugement et sans erreur.
 *
 * La valeur brute n'est **pas** conservée : CCR n'a besoin que de savoir si la
 * variable est présente et si elle est canonique. C'est suffisant pour le
 * futur avertissement de `ccr doctor` (§30) et cela évite de recopier un
 * fragment d'environnement dans un diagnostic.
 */
export interface LegacyEnvObservation {
  readonly variable: string;
  readonly present: boolean;
  /** Présente et exactement `"1"` : le contournement est demandé. */
  readonly canonical: boolean;
  /**
   * Présente avec une autre valeur. Signifie `false` et **n'est jamais une
   * erreur** (§13.1) ; `doctor` pourra le signaler en `ATTENTION`.
   */
  readonly nonCanonical: boolean;
}

export function observeLegacyEnv(env: NodeJS.ProcessEnv = process.env): LegacyEnvObservation {
  const raw = env[LEGACY_SKIP_GIT_REPO_CHECK_ENV];
  const present = raw !== undefined;
  const canonical = raw === LEGACY_SKIP_GIT_REPO_CHECK_CANONICAL;
  return {
    variable: LEGACY_SKIP_GIT_REPO_CHECK_ENV,
    present,
    canonical,
    nonCanonical: present && !canonical,
  };
}

// --------------------------------------------------------------------------
// Configuration effective
// --------------------------------------------------------------------------

/** D'où vient le document lu : un fichier réel, ou les valeurs par défaut. */
export type ConfigOrigin = 'file' | 'defaults';

/** Provenance d'une valeur effective, destinée au futur `ccr doctor`. */
export type ConfigValueSource = 'legacy-env' | 'config' | 'default';

export interface LoadedConfig {
  readonly config: CcrConfig;
  readonly origin: ConfigOrigin;
  /** Chemin canonique consulté, y compris lorsque le fichier est absent. */
  readonly path: string;
}

export interface EffectiveConfig {
  readonly preflight: {
    readonly offerInteractiveLogin: boolean;
    /** Jamais `legacy-env` : aucune variable historique ne gouverne ce champ. */
    readonly source: ConfigValueSource;
  };
  readonly codex: {
    readonly skipGitRepoCheck: boolean;
    readonly source: ConfigValueSource;
  };
  readonly legacyEnv: LegacyEnvObservation;
  readonly configPath: string;
  readonly configOrigin: ConfigOrigin;
}

/**
 * Calcule la configuration effective globale.
 *
 * Table de vérité normative de la variable historique (§13.1), reprise à
 * l'identique du comportement V1 :
 *
 *   absente                 → configuration utilisateur, puis défaut
 *   présente, exactement "1" → true
 *   présente, autre valeur   → false, sans consulter la configuration
 *
 * Le troisième cas est délibéré : la variable est présente, donc elle décide.
 * Il ne produit aucune erreur.
 */
export function resolveEffectiveConfig(
  loaded: LoadedConfig,
  env: NodeJS.ProcessEnv = process.env,
): EffectiveConfig {
  const legacyEnv = observeLegacyEnv(env);
  const fromFile: ConfigValueSource = loaded.origin === 'file' ? 'config' : 'default';

  const codex = legacyEnv.present
    ? { skipGitRepoCheck: legacyEnv.canonical, source: 'legacy-env' as ConfigValueSource }
    : { skipGitRepoCheck: loaded.config.codex.skip_git_repo_check, source: fromFile };

  return {
    preflight: {
      offerInteractiveLogin: loaded.config.preflight.offer_interactive_login,
      source: fromFile,
    },
    codex,
    legacyEnv,
    configPath: loaded.path,
    configOrigin: loaded.origin,
  };
}
