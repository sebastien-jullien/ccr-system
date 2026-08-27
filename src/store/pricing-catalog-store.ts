/**
 * Lecture du catalogue tarifaire versionné (CCR V2.2, `V2.2-IMP-11`).
 *
 * ## Où il vit, et pourquoi là
 *
 * ```text
 * <dépôt>/pricing/current.json          sélecteur — cite une version
 * <dépôt>/pricing/catalogs/<version>.json   instantané immuable
 * ```
 *
 * Versionné **avec le code**, et pas ailleurs. `catalog_version` est un
 * identifiant opaque que toute estimation future citera ; s'il désignait un
 * fichier propre à un poste, deux machines pourraient rendre des montants
 * différents en citant la même version, et la garantie de reproductibilité
 * deviendrait invérifiable.
 *
 * ## Absence : l'état normal
 *
 * CCR n'embarque aucun tarif. `pricing/current.json` n'existe pas, et la
 * lecture rend `NONE` — ce qui n'est ni une erreur, ni un catalogue vide. La
 * distinction compte : le futur estimateur en tirera `PRICING_UNKNOWN`, jamais
 * un montant nul.
 *
 * En revanche, un sélecteur qui **cite** une version introuvable ou illisible
 * est une erreur : demander une version précise et ne pas la trouver n'est pas
 * la même chose que n'en demander aucune.
 *
 * ## Lecture seule, hors ligne
 *
 * Aucune écriture, aucune mutation, aucun réseau. Une évolution tarifaire passe
 * par une modification versionnée du dépôt, jamais par une commande CCR : c'est
 * ce qui rend une version citée encore vérifiable des mois plus tard.
 */

import path from 'node:path';

import { CcrError } from '../core/errors.ts';
import { isPricingCatalogVersion, validatePricingCatalog } from '../core/pricing-catalog.ts';
import type { PricingCatalog } from '../core/pricing-catalog.ts';
import { readJsonFile } from './atomic-file.ts';
import { CCR_ROOT } from './layout.ts';

export const PRICING_DIR_NAME = 'pricing';
export const PRICING_CURRENT_FILE_NAME = 'current.json';
export const PRICING_CATALOGS_DIR_NAME = 'catalogs';

export interface PricingCatalogPaths {
  readonly root: string;
  readonly current: string;
  readonly catalogsDir: string;
}

export function pricingCatalogPaths(repoRoot: string = CCR_ROOT): PricingCatalogPaths {
  const root = path.join(repoRoot, PRICING_DIR_NAME);
  return {
    root,
    current: path.join(root, PRICING_CURRENT_FILE_NAME),
    catalogsDir: path.join(root, PRICING_CATALOGS_DIR_NAME),
  };
}

/**
 * Chemin d'une version, ou `undefined` si l'identifiant ne peut pas en désigner
 * un sans quitter le répertoire.
 *
 * Opaque ne veut pas dire quelconque : la version participe à un nom de
 * fichier, et un identifiant libre y ouvrirait une traversée de chemin. Le
 * confinement est vérifié après résolution, et pas seulement par la forme.
 */
export function pricingCatalogVersionPath(
  paths: PricingCatalogPaths,
  version: string,
): string | undefined {
  if (!isPricingCatalogVersion(version)) return undefined;
  const resolved = path.resolve(paths.catalogsDir, `${version}.json`);
  const inside = path.resolve(paths.catalogsDir) + path.sep;
  return resolved.startsWith(inside) ? resolved : undefined;
}

/** Le catalogue courant, ou l'absence — qui est un fait, pas une panne. */
export type CurrentPricingCatalog =
  | { readonly kind: 'NONE' }
  | { readonly kind: 'CONFIGURED'; readonly catalog: PricingCatalog };

const SELECTOR_KEYS: readonly string[] = ['schema_version', 'catalog_version'];

function readFailed(message: string, details: Record<string, unknown>, cause?: unknown): CcrError {
  return new CcrError('PRICING_CATALOG_READ_FAILED', message, {
    details,
    ...(cause === undefined ? {} : { cause }),
  });
}

function invalid(message: string, details: Record<string, unknown> = {}): CcrError {
  return new CcrError('PRICING_CATALOG_INVALID', message, { details });
}

/**
 * Lit une version précise.
 *
 * `undefined` signifie **introuvable** — un fait que l'appelant interprète. Un
 * document présent mais non conforme lève : le requalifier en absence
 * transformerait un catalogue corrompu en tarif silencieusement manquant.
 */
export async function readPricingCatalogVersion(
  version: string,
  repoRoot: string = CCR_ROOT,
): Promise<PricingCatalog | undefined> {
  const paths = pricingCatalogPaths(repoRoot);
  const file = pricingCatalogVersionPath(paths, version);
  if (file === undefined) {
    throw invalid(
      `catalogue tarifaire : « ${version} » n'est pas un identifiant de version utilisable.`,
      { catalog_version: version },
    );
  }

  let raw: unknown;
  try {
    raw = await readJsonFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof SyntaxError) {
      throw invalid(`catalogue tarifaire « ${version} » : JSON illisible.`, {
        catalog_version: version,
        path: file,
      });
    }
    throw readFailed(
      `catalogue tarifaire « ${version} » : lecture impossible.`,
      { catalog_version: version, path: file },
      error,
    );
  }

  const catalog = validatePricingCatalog(raw);
  if (catalog.catalog_version !== version) {
    throw invalid(
      `catalogue tarifaire : le fichier « ${version} » déclare la version ` +
        `« ${catalog.catalog_version} ». Un instantané qui ne se nomme pas lui-même ne peut ` +
        'pas être cité.',
      { requested: version, declared: catalog.catalog_version },
    );
  }
  return catalog;
}

/**
 * Lit le catalogue courant.
 *
 * Aucun sélecteur : `NONE`. Un sélecteur présent engage en revanche à trouver
 * ce qu'il cite.
 */
export async function readCurrentPricingCatalog(
  repoRoot: string = CCR_ROOT,
): Promise<CurrentPricingCatalog> {
  const paths = pricingCatalogPaths(repoRoot);

  let raw: unknown;
  try {
    raw = await readJsonFile(paths.current);
  } catch (error) {
    // Aucun catalogue courant : l'état normal de ce dépôt, qui n'embarque
    // aucun tarif.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'NONE' };
    if (error instanceof SyntaxError) {
      throw invalid('catalogue tarifaire : le sélecteur courant est un JSON illisible.', {
        path: paths.current,
      });
    }
    throw readFailed(
      'catalogue tarifaire : le sélecteur courant est illisible.',
      { path: paths.current },
      error,
    );
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw invalid('catalogue tarifaire : le sélecteur courant doit être un objet JSON.', {
      path: paths.current,
    });
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (SELECTOR_KEYS.includes(key)) continue;
    throw invalid(`catalogue tarifaire : champ « ${key} » inconnu dans le sélecteur courant.`, {
      field: key,
    });
  }
  if (record['schema_version'] !== 1) {
    throw invalid(
      `catalogue tarifaire : sélecteur en schema_version ${String(record['schema_version'])} ` +
        'non supportée.',
      { field: 'schema_version' },
    );
  }

  const version = record['catalog_version'];
  if (!isPricingCatalogVersion(version)) {
    throw invalid(
      'catalogue tarifaire : le sélecteur courant doit citer un identifiant de version valide.',
      { field: 'catalog_version' },
    );
  }

  const catalog = await readPricingCatalogVersion(version, repoRoot);
  if (catalog === undefined) {
    throw readFailed(
      `catalogue tarifaire : le sélecteur courant cite « ${version} », qui n'existe pas. ` +
        "Demander une version précise et ne pas la trouver n'est pas la même chose que n'en " +
        'demander aucune.',
      { catalog_version: version, path: paths.catalogsDir },
    );
  }
  return { kind: 'CONFIGURED', catalog };
}
