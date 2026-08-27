/**
 * Assets du cockpit — **allowlist**, jamais un serveur de fichiers.
 *
 * La règle tient en une phrase : aucun segment d'URL ne devient jamais un
 * chemin. La table ci-dessous associe une route exacte à un nom de fichier
 * décidé ici ; une requête qui n'y figure pas reçoit `404`, quelle que soit sa
 * forme.
 *
 * Conséquence directe : `../`, `%2e%2e`, un double encodage ou un chemin absolu
 * ne sont pas « filtrés », ils sont **hors sujet** — il n'existe aucun chemin
 * d'exécution où ils pourraient être concaténés à quoi que ce soit. C'est plus
 * robuste qu'une normalisation, qui doit avoir raison à chaque fois quand une
 * allowlist n'a besoin d'avoir raison qu'une fois.
 *
 * Aucun listage de répertoire, aucun accès à un fichier du dépôt, aucun MIME
 * deviné : chaque entrée porte le sien.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Racines servies — **deux**, constantes, décidées ici.
 *
 * Jamais construites depuis une requête, jamais énumérées, jamais parcourues.
 * La seconde existe parce que `V2.3-S2` livre au navigateur un module tiers qui
 * ne vit pas dans `web/` : l'analyseur Markdown. Le faire copier dans les
 * sources dupliquerait un fichier de dépendance ; une racine nommée conserve
 * exactement l'invariant — la route ne construit toujours rien.
 */
const ASSET_ROOTS = {
  web: fileURLToPath(new URL('./web/', import.meta.url)),
  vendor: fileURLToPath(new URL('../../node_modules/marked/lib/', import.meta.url)),
} as const;

export type CockpitAssetRoot = keyof typeof ASSET_ROOTS;

export interface CockpitAsset {
  readonly root: CockpitAssetRoot;
  readonly file: string;
  readonly contentType: string;
}

/**
 * Table close des routes servies.
 *
 * `/` n'y figure pas : le shell est servi par le bootstrap, qui pose aussi la
 * session.
 */
const SCRIPT = 'text/javascript; charset=utf-8';

export const COCKPIT_ASSETS: ReadonlyMap<string, CockpitAsset> = new Map([
  ['/assets/app.js', { root: 'web', file: 'app.js', contentType: SCRIPT }],
  ['/assets/cockpit.js', { root: 'web', file: 'cockpit.js', contentType: SCRIPT }],
  ['/assets/api.js', { root: 'web', file: 'api.js', contentType: SCRIPT }],
  ['/assets/render.js', { root: 'web', file: 'render.js', contentType: SCRIPT }],
  ['/assets/labels.js', { root: 'web', file: 'labels.js', contentType: SCRIPT }],
  ['/assets/styles.css', { root: 'web', file: 'styles.css', contentType: 'text/css; charset=utf-8' }],
  // V2.3-S2 — rendu Markdown. Servis dès S2, consommés depuis S3.
  ['/assets/markdown.js', { root: 'web', file: 'markdown.js', contentType: SCRIPT }],
  ['/assets/link-safety.js', { root: 'web', file: 'link-safety.js', contentType: SCRIPT }],
  // V2.3-S3 — fil de la contre-expertise.
  ['/assets/conversation.js', { root: 'web', file: 'conversation.js', contentType: SCRIPT }],
  // Module tiers autonome, servi depuis l'origine locale : la politique
  // `script-src 'self'` reste inchangée, et aucun CDN n'est contacté.
  ['/assets/vendor/marked.esm.js', { root: 'vendor', file: 'marked.esm.js', contentType: SCRIPT }],
]);

/** Fichier du shell, servi par le bootstrap « / ». */
export const SHELL_FILE = 'index.html';

export interface LoadedAsset {
  readonly contentType: string;
  readonly body: string;
}

/**
 * Charge un asset **déclaré**.
 *
 * `route` est comparée à la table, jamais interprétée : le nom de fichier vient
 * de la table, et il est joint à un répertoire constant.
 */
export async function loadCockpitAsset(route: string): Promise<LoadedAsset | undefined> {
  const asset = COCKPIT_ASSETS.get(route);
  if (asset === undefined) return undefined;
  // Racine décidée par la table, nom de fichier décidé par la table : les deux
  // moitiés du chemin viennent d'ici, aucune de la requête.
  const body = await readFile(path.join(ASSET_ROOTS[asset.root], asset.file), 'utf8');
  return { contentType: asset.contentType, body };
}

/** Charge le shell statique. Aucune donnée CCR n'y est injectée. */
export function loadCockpitShell(): Promise<string> {
  return readFile(path.join(ASSET_ROOTS.web, SHELL_FILE), 'utf8');
}
