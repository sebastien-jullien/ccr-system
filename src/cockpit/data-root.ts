/**
 * Identité du **CCR data root** — levée d'ambiguïté assignée au Slice 2
 * (V0.2 §15.3, §15.4 ; amendement V2-IMP-35).
 *
 * ## Le problème posé
 *
 * V0.2 parle d'un `<ccr-data-root>` sans jamais le définir. Le dépôt, lui,
 * connaît deux racines distinctes, et **aucune** ne contient l'autre :
 *
 * ```text
 * ~/.ccr/config.json                          configuration globale du poste
 * <repo>/.ccr/runs/                           runs, ou $CCR_RUNS_DIR
 * ```
 *
 * La configuration est globale à l'utilisateur, partagée par tous les runs, et
 * n'est pas un espace de stockage de runs. Elle ne peut donc pas servir
 * d'identité à un serveur qui sert **des runs**. Et le parent du répertoire de
 * runs ne peut pas davantage servir d'identité : le choisir serait
 * arbitraire, exactement ce que cette levée d'ambiguïté interdit.
 *
 * ## La décision
 *
 * ```text
 * CCR data root              ≡ le répertoire de runs, canonicalisé
 * runs directory             <ccr-data-root>/
 * cockpit control directory  <ccr-data-root>/cockpit/
 * server.lock                <ccr-data-root>/cockpit/server.lock
 * ```
 *
 * Le répertoire de runs est le **seul** chemin que CCR norme réellement et
 * persiste : `resolveRunsDir()` en est l'unique règle, et `$CCR_RUNS_DIR` son
 * unique point de contrôle. L'unicité du serveur porte donc exactement sur ce
 * que le serveur sert.
 *
 * Le sous-répertoire `cockpit/` cohabite sans risque avec les runs :
 * `listRunIds()` ne retient que les entrées satisfaisant `isRunId()`, et
 * `cockpit` n'en est pas un. Aucun layout V1 n'est modifié.
 *
 * ## Canonicalisation
 *
 * Deux chemins désignant le même répertoire réel ne doivent pas produire deux
 * serveurs indépendants ; deux chemins logiquement distincts ne doivent pas
 * fusionner. L'algorithme est décrit et prouvé sur `canonicalizeCcrDataRoot`.
 *
 * ## Data root inexistant
 *
 * Le cockpit peut légitimement être lancé avant le premier run. Deux fonctions
 * cohabitent, et la distinction est normative :
 *
 * ```text
 * canonicalizeCcrDataRoot   pure, aucun effet de bord
 *                           ancêtre réel canonicalisé + suffixe lexical
 *                           → utilisée par l'inspection (clear-stale-lock)
 *
 * materializeCcrDataRoot    crée le répertoire PUIS canonicalise
 *                           → utilisée par le démarrage du serveur
 * ```
 *
 * Pourquoi deux. La forme pure ne peut pas connaître la casse réelle d'un
 * composant qui n'existe pas encore : elle conserve celle de l'appelant. Deux
 * orthographes du même root logique produiraient donc deux identités **avant**
 * création, et une seule après — une instabilité que le démarrage du serveur ne
 * peut pas se permettre, puisque c'est elle qui décide de l'unicité.
 *
 * Le serveur crée de toute façon `<root>/cockpit/`, donc `<root>` : matérialiser
 * d'abord n'ajoute aucun effet de bord, et fait décider l'OS plutôt que
 * l'orthographe de l'appelant. Deux processus concurrents sur le même root
 * inexistant convergent alors vers la même identité, et un seul `server.lock`
 * peut être créé.
 *
 * L'inspection, elle, reste sans effet de bord : un `clear-stale-lock` ne doit
 * pas créer le répertoire qu'il vient consulter. Sur un root inexistant il n'y
 * a de toute façon aucun verrou à lever.
 *
 * ## Fail-closed
 *
 * `ENOENT` est le **seul** code d'erreur porteur d'une sémantique : « ce
 * composant n'existe pas encore », traité par la remontée décrite ci-dessus.
 *
 * Toute autre erreur de résolution — `EACCES`, `EPERM`, `ELOOP`, `ENOTDIR`,
 * `EIO`… — signifie que l'identité canonique **n'a pas pu être établie**. Elle
 * ne signifie pas que la forme lexicale est cette identité.
 *
 * ```text
 * realpath(alias A) échoue → forme lexicale A
 * realpath(alias B) échoue → forme lexicale B
 * ```
 *
 * Deux formes lexicales distinctes peuvent parfaitement désigner le même
 * stockage. Se rabattre sur elles rendrait donc possible ce que l'invariant
 * interdit : deux cockpits sur un seul data root réel. CCR échoue explicitement
 * plutôt que de deviner — et ne supprime alors aucun verrou.
 */

import { realpathSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { CcrError } from '../core/errors.ts';

import { resolveRunsDir } from '../store/layout.ts';

/** Sous-répertoire de contrôle du cockpit, à la racine du data root. */
export const COCKPIT_DIR_NAME = 'cockpit';
export const SERVER_LOCK_FILE_NAME = 'server.lock';

/**
 * Résolution filesystem d'un chemin réel.
 *
 * Couture de test : elle existe pour injecter des échecs — `EACCES`, `ELOOP`,
 * `ENOTDIR` — qu'aucun système de fichiers ne produit de façon reproductible.
 * Sous Windows, un chemin situé sous un fichier rend `ENOENT`, pas `ENOTDIR` :
 * sans couture, la discipline fail-closed ne serait pas vérifiable.
 * La production emploie toujours `realpathSync.native`.
 */
export type RealpathResolver = (target: string) => string;

export interface CanonicalizeOptions {
  readonly realpath?: RealpathResolver;
}

export interface CockpitDataRoot {
  /** Chemin absolu canonique. Identité du serveur. */
  readonly dataRoot: string;
  /** Répertoire des runs. Identique au data root — voir en-tête. */
  readonly runsDir: string;
  readonly controlDir: string;
  readonly serverLock: string;
}

/**
 * Canonicalise un chemin, y compris lorsqu'il n'existe pas encore.
 *
 * Algorithme, exactement :
 *
 * ```text
 * 1. absolute ← path.resolve(target)          absorbe « . », « .. », le cwd
 * 2. current  ← absolute ; pending ← []
 * 3. tant que realpath(current) échoue en ENOENT :
 *        pending.push(basename(current))
 *        current ← dirname(current)
 *        si current est sa propre racine : rendre absolute
 * 4. rendre join(realpath(current), ...pending inversé)
 * ```
 *
 * Le suffixe n'est donc **jamais perdu** : il est réattaché, dans l'ordre, au
 * premier ancêtre réellement résolu. `parent/a` et `parent/b` inexistants
 * restent distincts ; ils ne s'effondrent pas sur `parent`.
 *
 * `realpathSync.native` délègue à l'OS : il déplie liens symboliques et
 * jonctions, et rend sous Windows la casse réelle et les noms courts 8.3 — ce
 * que `path.resolve` ne fait pas. Cette restitution ne vaut évidemment que pour
 * les composants qui existent ; voir l'en-tête pour la conséquence.
 *
 * Toute erreur autre qu'`ENOENT` fait **échouer** la résolution
 * (`CCR_DATA_ROOT_UNRESOLVABLE`). Voir l'en-tête : se rabattre sur la forme
 * lexicale reviendrait à affirmer une identité qu'on n'a pas pu établir.
 */
export function canonicalizeCcrDataRoot(target: string, options: CanonicalizeOptions = {}): string {
  const resolve = options.realpath ?? ((value: string) => realpathSync.native(value));
  const absolute = path.resolve(target);
  const pending: string[] = [];
  let current = absolute;

  for (;;) {
    try {
      const real = resolve(current);
      return pending.length === 0 ? real : path.join(real, ...pending.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        throw new CcrError(
          'CCR_DATA_ROOT_UNRESOLVABLE',
          `L'identité canonique du CCR data root n'a pas pu être établie : ${absolute}. ` +
            `La résolution du chemin a échoué (${code ?? 'erreur inattendue'}). ` +
            "Aucun cockpit n'est démarré et aucun verrou n'est modifié.",
          { details: { path: absolute, unresolved: current, code: code ?? null } },
        );
      }
      const parent = path.dirname(current);
      // Racine du volume atteinte sans jamais rien résoudre : il n'existe aucun
      // ancêtre réel sur lequel fonder une identité.
      if (parent === current) {
        throw new CcrError(
          'CCR_DATA_ROOT_UNRESOLVABLE',
          `L'identité canonique du CCR data root n'a pas pu être établie : ${absolute}. ` +
            "Aucun ancêtre existant n'a pu être résolu.",
          { details: { path: absolute, code: 'NO_REAL_ANCESTOR' } },
        );
      }
      pending.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Résout l'identité complète du data root cockpit.
 *
 * `explicitRunsDir` suit exactement la même règle que toutes les commandes V1
 * (`--runs-dir`, puis `$CCR_RUNS_DIR`, puis le défaut) : le cockpit n'invente
 * pas une seconde résolution de stockage.
 */
export function resolveCockpitDataRoot(
  explicitRunsDir?: string,
  options: CanonicalizeOptions = {},
): CockpitDataRoot {
  const dataRoot = canonicalizeCcrDataRoot(resolveRunsDir(explicitRunsDir), options);
  const controlDir = path.join(dataRoot, COCKPIT_DIR_NAME);
  return {
    dataRoot,
    runsDir: dataRoot,
    controlDir,
    serverLock: path.join(controlDir, SERVER_LOCK_FILE_NAME),
  };
}

/**
 * Identité du data root pour le **démarrage du serveur**.
 *
 * Matérialise le répertoire avant de le canonicaliser : à partir de là,
 * l'identité est celle que l'OS rapporte, pas celle que l'appelant a tapée.
 * C'est ce qui rend l'unicité indépendante de l'orthographe et de la
 * sensibilité à la casse du système de fichiers.
 *
 * `mkdir` récursif est idempotent : deux processus concurrents sur le même root
 * inexistant réussissent tous deux, puis lisent la **même** vérité disque.
 */
export async function materializeCcrDataRoot(
  explicitRunsDir?: string,
  options: CanonicalizeOptions = {},
): Promise<CockpitDataRoot> {
  const target = resolveRunsDir(explicitRunsDir);
  try {
    await mkdir(target, { recursive: true });
  } catch (error) {
    throw new CcrError(
      'CCR_DATA_ROOT_UNRESOLVABLE',
      `Le CCR data root n'a pas pu être préparé : ${target} ` +
        `(${(error as NodeJS.ErrnoException).code ?? 'erreur inattendue'}). ` +
        "Aucun cockpit n'est démarré.",
      { details: { path: target, code: (error as NodeJS.ErrnoException).code ?? null } },
    );
  }
  // La canonicalisation reste fail-closed : une matérialisation réussie ne
  // garantit pas qu'une identité canonique puisse être établie.
  return resolveCockpitDataRoot(target, options);
}
