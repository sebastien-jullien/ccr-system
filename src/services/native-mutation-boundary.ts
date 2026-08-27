/**
 * Couture de mutation native — `BEFORE` / `BODY` / `SETTLED`
 * (V2.1-IMP-17A, fondation de concurrence HTTP).
 *
 * ## Le problème que ce module existe pour résoudre
 *
 * Le contrat de concurrence historique n'est pas « vérifier une révision ».
 * C'est **vérifier et agir dans la même section critique** :
 *
 * ```text
 * FAUX     lire la révision → appeler le service → le service prend le verrou
 *          entre les deux, une autre mutation peut s'insérer : la vérification
 *          portait sur un monde révolu (TOCTOU)
 *
 * FAUX     prendre le verrou → vérifier → appeler le service natif
 *          le service reprend le verrou : `link` échoue `EEXIST`, la liveness
 *          désigne notre propre processus, et l'appel est refusé
 *          `RUN_ALREADY_LOCKED`
 *
 * JUSTE    le service prend SON verrou → BEFORE → corps → SETTLED → release
 * ```
 *
 * Le run lock n'est pas réentrant — publication par lien dur exclusif, aucun
 * contrôle de propriétaire, aucun compteur de récursion. Il n'existe donc
 * qu'une seule position possible pour la précondition : **à l'intérieur du
 * verrou que le service détient déjà**.
 *
 * ## Pourquoi `SETTLED` existe
 *
 * `revision_after` doit être calculée sous le **même** verrou que l'effet, sans
 * quoi elle décrirait un monde qui a déjà pu changer. Et elle doit l'être aussi
 * lorsque l'opération lève : plusieurs chemins natifs écrivent des faits
 * canoniques **avant** de rejeter — le garde-fou de taille journalise
 * `transfer_blocked` et passe en `WAITING_HUMAN / HUMAN`, un `process_failed`
 * est durable. Une intention qui échoue n'implique pas un état inchangé.
 *
 * ## Ce que cette couture n'est pas
 *
 * Elle ne connaît pas HTTP. Elle ne décide aucune branche métier : après un
 * `BEFORE` qui n'a pas levé, le service se comporte exactement comme sans elle.
 * Elle ne touche ni garde, ni planificateur, ni classifieur, ni statut de
 * reprise. Elle est **optionnelle** : absente, le comportement est
 * rigoureusement celui d'avant — c'est le cas de tous les appels de la CLI.
 */

import { CcrError } from '../core/errors.ts';
import { withRunLock } from '../lock/run-lock.ts';
import { runPaths } from '../store/layout.ts';
import { readPersistedManifest } from '../store/native-store.ts';

/** Issue du corps, telle que `settled` l'observe. */
export type NativeMutationOutcome =
  | { readonly kind: 'SUCCEEDED' }
  | { readonly kind: 'FAILED'; readonly error: unknown };

export interface NativeMutationBoundary {
  /**
   * Sous le verrou, après la validation de génération, **avant** le premier
   * guard métier, le premier fait durable et tout appel fournisseur.
   *
   * Lever ici interrompt l'opération sans qu'aucune tentative de mutation
   * n'ait commencé. C'est la position d'une précondition de vue :
   * `expected_revision` doit l'emporter sur un refus métier qui ne serait
   * constaté qu'ensuite.
   */
  before?(): void | Promise<void>;
  /**
   * Sous le **même** verrou, après le corps, avant la libération.
   *
   * Appelée sur succès **et** sur échec — un échec peut avoir produit des faits
   * canoniques. N'est jamais appelée si `before` a levé : aucune tentative n'a
   * eu lieu, et il n'y a rien à observer.
   */
  settled?(outcome: NativeMutationOutcome): void | Promise<void>;
}

export interface NativeMutationInput {
  readonly runsDir: string;
  readonly runId: string;
  /** Commande portée par le verrou, identique à celle d'aujourd'hui. */
  readonly command: string;
  readonly boundary?: NativeMutationBoundary;
}

/**
 * Validation de génération — la lecture minimale exigée avant `BEFORE`.
 *
 * Le manifest, et lui seul : c'est lui qui décide de la génération d'un run, ni
 * un événement, ni un champ runtime, ni un fournisseur. Calculer une révision
 * native sur un run historique n'aurait aucun sens, et la couture ne doit donc
 * jamais s'exécuter avant que la génération ne soit établie.
 *
 * Le corps du service relit ensuite ses propres faits : ce surcoût est un petit
 * document JSON sous verrou, et c'est le prix de l'ordre exigé par le contrat.
 */
async function assertNativeGeneration(runsDir: string, runId: string): Promise<void> {
  const persisted = await readPersistedManifest(runPaths(runsDir, runId));
  if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') {
    throw new CcrError(
      'SCHEMA_VERSION_UNSUPPORTED',
      `Le run ${runId} est de génération ${persisted.execution_mode} : les moteurs natifs ne le traitent ` +
        'pas, et ne le convertissent pas.',
      { details: { runId, execution_mode: persisted.execution_mode } },
    );
  }
}

/**
 * Exécute une mutation native sous run lock, couture comprise.
 *
 * Ordre garanti, et c'est tout l'objet de ce module :
 *
 * ```text
 * verrou  →  génération  →  BEFORE  →  corps  →  SETTLED  →  release
 * ```
 *
 * Un seul `withRunLock` : le verrou n'est jamais repris, ni par la couture, ni
 * par le corps.
 */
export async function withNativeMutation<T>(input: NativeMutationInput, body: () => Promise<T>): Promise<T> {
  const paths = runPaths(input.runsDir, input.runId);
  const boundary = input.boundary;

  return withRunLock(paths, input.command, async () => {
    await assertNativeGeneration(input.runsDir, input.runId);

    // `BEFORE` lève ⇒ aucun corps, aucun `SETTLED`. Convention unique et
    // documentée : rien n'a été tenté, il n'y a donc aucune résolution à
    // observer — et la révision qui a motivé le refus est déjà connue de la
    // précondition elle-même.
    await boundary?.before?.();

    let result: T;
    try {
      result = await body();
    } catch (error) {
      // Le corps a pu écrire avant de lever. `SETTLED` doit donc s'exécuter
      // ici aussi, et son propre échec ne doit jamais masquer l'erreur
      // d'origine — c'est la règle déjà appliquée par la composition
      // historique des opérations longues.
      try {
        await boundary?.settled?.({ kind: 'FAILED', error });
      } catch {
        // Volontairement avalé : l'erreur métier est plus informative.
      }
      throw error;
    }

    // Sur succès, un `SETTLED` qui échoue est un vrai échec : l'appelant
    // attendait une résolution observée sous verrou, et ne l'a pas obtenue.
    await boundary?.settled?.({ kind: 'SUCCEEDED' });
    return result;
  });
}
