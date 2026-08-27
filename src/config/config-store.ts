/**
 * Config store — configuration locale CCR (spécification V1.1, §11, §20, §21).
 *
 *   ~/.ccr/config.json          document canonique
 *   ~/.ccr/config.json.lock     verrou d'écriture (§20.1)
 *
 * Rôles :
 *
 *  - **lecture** : jamais verrouillée. Un lecteur — `doctor` demain — ne doit
 *    pas pouvoir bloquer une écriture, ni être bloqué par elle ;
 *  - **écriture** : validée avant tout contact avec le disque, sérialisée par
 *    le verrou de configuration, puis rendue durable par la primitive atomique
 *    déjà éprouvée en V1 (`writeJsonAtomic`). Aucune primitive atomique n'est
 *    réécrite ici.
 *
 * L'absence de fichier n'est pas une erreur (§22) : elle produit les valeurs
 * par défaut, en conservant l'information « ces valeurs viennent du défaut ».
 *
 * Ce module ne connaît ni Claude, ni Codex, ni aucun credential.
 */

import { homedir } from 'node:os';
import path from 'node:path';

import { CcrError } from '../core/errors.ts';
import { acquireConfigLock } from '../lock/config-lock.ts';
import { readJsonFile, writeJsonAtomic } from '../store/atomic-file.ts';
import type { CcrConfig, EffectiveConfig, LoadedConfig } from './config-schema.ts';
import { defaultConfig, resolveEffectiveConfig, validateConfig } from './config-schema.ts';

/** Répertoire personnel CCR : `~/.ccr`, soit `%USERPROFILE%\.ccr` sous Windows. */
export const CCR_HOME_DIR_NAME = '.ccr';
export const CONFIG_FILE_NAME = 'config.json';

export interface ConfigStoreOptions {
  /**
   * Chemin explicite du document de configuration.
   *
   * Injection obligatoire dans les tests : aucune suite de tests ne doit
   * pouvoir écrire dans la configuration réelle de l'utilisateur.
   */
  readonly configPath?: string;
  /** Commande détentrice du verrou, pour le diagnostic d'un `CONFIG_BUSY`. */
  readonly command?: string;
}

export function defaultConfigPath(home: string = homedir()): string {
  return path.join(home, CCR_HOME_DIR_NAME, CONFIG_FILE_NAME);
}

export function resolveConfigPath(explicit?: string): string {
  return explicit !== undefined && explicit.length > 0 ? path.resolve(explicit) : defaultConfigPath();
}

// --------------------------------------------------------------------------
// Lecture
// --------------------------------------------------------------------------

/**
 * Lit la configuration canonique.
 *
 * Quatre issues, sans zone grise :
 *
 *   fichier absent            → valeurs par défaut, `origin: 'defaults'`
 *   fichier valide            → document validé, `origin: 'file'`
 *   lecture impossible        → `CONFIG_READ_FAILED`
 *   lu mais document douteux  → `CONFIG_INVALID` / `CONFIG_SCHEMA_UNSUPPORTED`
 *
 * « Illisible » et « invalide » sont deux faits distincts : un `EACCES` ou un
 * `EISDIR` n'apprend rien sur le contenu du document, et n'appelle pas la même
 * remédiation qu'une accolade manquante. Aucun des deux ne devient un défaut :
 * ce serait transformer une incertitude en succès.
 */
export async function readConfig(options: ConfigStoreOptions = {}): Promise<LoadedConfig> {
  const file = resolveConfigPath(options.configPath);

  let raw: unknown;
  try {
    raw = await readJsonFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { config: defaultConfig(), origin: 'defaults', path: file };
    }
    if (error instanceof SyntaxError) {
      throw new CcrError('CONFIG_INVALID', `Configuration CCR invalide : JSON illisible dans ${file}.`, {
        details: { path: file },
        cause: error,
      });
    }
    // Seul le code système est conservé : aucun fragment de contenu, aucune
    // donnée d'environnement.
    throw new CcrError(
      'CONFIG_READ_FAILED',
      `Configuration CCR présente mais impossible à lire : ${file}. Vérifiez les droits d'accès du fichier.`,
      { details: { path: file, systemCode: (error as NodeJS.ErrnoException).code ?? null }, cause: error },
    );
  }

  return { config: validateConfig(raw), origin: 'file', path: file };
}

/** Configuration effective globale : `legacy env → config → défaut` (§13.1). */
export async function loadEffectiveConfig(
  options: ConfigStoreOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<EffectiveConfig> {
  return resolveEffectiveConfig(await readConfig(options), env);
}

// --------------------------------------------------------------------------
// Écriture
// --------------------------------------------------------------------------

async function persist(file: string, config: CcrConfig): Promise<void> {
  try {
    await writeJsonAtomic(file, config);
  } catch (error) {
    throw new CcrError(
      'CONFIG_WRITE_FAILED',
      `Écriture de la configuration CCR impossible : ${file}. La configuration précédente reste en vigueur.`,
      { details: { path: file, cause: (error as NodeJS.ErrnoException).code ?? null }, cause: error },
    );
  }
}

/**
 * Écrit la configuration.
 *
 * La validation précède l'acquisition du verrou et tout contact avec le
 * disque : un document refusé ne peut donc pas remplacer un document valide.
 */
export async function writeConfig(config: CcrConfig, options: ConfigStoreOptions = {}): Promise<LoadedConfig> {
  const file = resolveConfigPath(options.configPath);
  const validated = validateConfig(config);

  const lock = await acquireConfigLock(file, options.command ?? 'config-write');
  try {
    await persist(file, validated);
  } finally {
    await lock.release();
  }

  return { config: validated, origin: 'file', path: file };
}

/**
 * Applique une modification sous verrou.
 *
 * C'est la primitive à utiliser dès qu'une valeur existante est conservée :
 * la lecture, la modification et l'écriture se déroulent sous le même verrou,
 * ce qui interdit le *lost update* décrit en §20.1. Deux appels concurrents ne
 * se recouvrent pas : le second échoue en `CONFIG_BUSY`.
 */
export async function updateConfig(
  mutate: (current: CcrConfig) => CcrConfig,
  options: ConfigStoreOptions = {},
): Promise<LoadedConfig> {
  const file = resolveConfigPath(options.configPath);

  const lock = await acquireConfigLock(file, options.command ?? 'config-update');
  try {
    const current = await readConfig({ configPath: file });
    const validated = validateConfig(mutate(current.config));
    await persist(file, validated);
    return { config: validated, origin: 'file', path: file };
  } finally {
    await lock.release();
  }
}
