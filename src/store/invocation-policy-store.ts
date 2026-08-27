/**
 * Persistance de la politique de quota d'un run (CCR V2.2, `V2.2-IMP-07`).
 *
 * Document **additif**, dans le répertoire du run, aux côtés des deux journaux
 * de gouvernance :
 *
 * ```text
 * <run>/invocation-policy.json
 * ```
 *
 * Hors `manifest.json`, hors `state.json`, hors journaux, et **hors révision
 * métier** : poser une politique ne doit pas invalider une vue de controverse
 * en cours, ni faire échouer un `expected_revision` pour une raison qui n'a
 * rien à voir avec ce que les experts se disent.
 *
 * Le même `RunPaths` sert les deux générations : un run historique peut porter
 * ce document sans la moindre migration, et son absence — le cas normal de tous
 * les runs antérieurs — reste parfaitement valide.
 *
 * ## Publication : complète, ou inexistante
 *
 * `writeJsonAtomic` remplacerait silencieusement une politique déjà posée, ce
 * que V0.1 interdit. Le protocole retenu est celui du verrou de run, déjà
 * éprouvé dans ce dépôt : écriture d'un fichier d'attente exclusif, `fsync`,
 * puis `link()` vers le nom définitif.
 *
 * ```text
 * open(staging, 'wx') → write → sync → link(staging, final) → unlink(staging)
 * ```
 *
 * `link` est à la fois exclusif — il échoue si le nom existe — et atomique. La
 * politique naît donc **complète**, ou ne naît pas : aucun lecteur ne peut
 * observer un document tronqué, et aucune écriture ne peut en écraser une
 * autre. C'est aussi ce qui rend le refus d'écrasement structurel plutôt que
 * dépendant d'un test d'existence préalable, dont la fenêtre serait ouverte.
 *
 * ## Ce que ce store ne fait pas
 *
 * Aucune mutation, aucun `updateQuota`. En V0.1 la politique est stable une
 * fois établie : les règles de modification en cours de run appartiennent à une
 * évolution distincte, avec ses propres questions d'autorisation, de
 * verrouillage et de traçabilité.
 */

import { link, open, unlink } from 'node:fs/promises';

import { CcrError, isCcrError } from '../core/errors.ts';
import {
  invocationPolicyDocument,
  resolveInvocationPolicy,
  validateInvocationPolicyDocument,
} from '../core/invocation-policy.ts';
import type {
  InvocationPolicyDocument,
  ResolvedInvocationPolicy,
} from '../core/invocation-policy.ts';
import { readJsonFile } from './atomic-file.ts';
import type { RunPaths } from './layout.ts';

export interface InvocationPolicyStore {
  /**
   * Document persisté, ou `undefined` si aucune politique n'a été posée.
   *
   * Un document **présent mais invalide** lève : le requalifier en absence
   * transformerait un problème de gouvernance en autorisation silencieuse.
   */
  read(): Promise<InvocationPolicyDocument | undefined>;
  /** La politique telle que le futur contrôle la lira. */
  resolve(): Promise<ResolvedInvocationPolicy>;
  /**
   * Établit la politique du run. Refuse d'en écraser une existante.
   *
   * `max_invocations` est validé avant toute écriture : un document refusé ne
   * laisse aucune trace sur le disque.
   */
  create(maxInvocations: number): Promise<InvocationPolicyDocument>;
}

export function openInvocationPolicyStore(paths: RunPaths): InvocationPolicyStore {
  const file = paths.invocationPolicy;

  const read = async (): Promise<InvocationPolicyDocument | undefined> => {
    let raw: unknown;
    try {
      raw = await readJsonFile(file);
    } catch (error) {
      // Seule l'absence est un fait — et c'est le fait « aucune politique ».
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      if (error instanceof SyntaxError) {
        throw new CcrError(
          'INVOCATION_POLICY_INVALID',
          `invocation-policy.json illisible pour le run ${paths.runId} : JSON invalide. ` +
            "Une politique corrompue n'est pas une politique absente.",
          { details: { runId: paths.runId, path: file }, cause: error },
        );
      }
      throw error;
    }
    return validateInvocationPolicyDocument(raw);
  };

  return {
    read,

    async resolve(): Promise<ResolvedInvocationPolicy> {
      return resolveInvocationPolicy(await read());
    },

    async create(maxInvocations: number): Promise<InvocationPolicyDocument> {
      // Validé d'abord : une limite refusée ne touche jamais le disque.
      const document = invocationPolicyDocument(maxInvocations);
      const payload = `${JSON.stringify(document, null, 2)}\n`;
      const staging = `${file}.${String(process.pid)}.${String(counter())}.tmp`;

      try {
        const handle = await open(staging, 'wx');
        try {
          await handle.writeFile(payload, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }

        try {
          await link(staging, file);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          throw new CcrError(
            'INVOCATION_POLICY_WRITE_FAILED',
            code === 'EEXIST'
              ? `Le run ${paths.runId} porte déjà une politique de quota. En V0.1 une politique ` +
                "est stable une fois établie : CCR ne l'écrase pas."
              : `La politique de quota du run ${paths.runId} n'a pas pu être publiée ` +
                `(${code ?? 'code inconnu'}).`,
            { details: { runId: paths.runId, path: file, code: code ?? null }, cause: error },
          );
        }
      } catch (error) {
        if (isCcrError(error)) throw error;
        throw new CcrError(
          'INVOCATION_POLICY_WRITE_FAILED',
          `La politique de quota du run ${paths.runId} n'a pas pu être écrite.`,
          { details: { runId: paths.runId, path: file }, cause: error },
        );
      } finally {
        await unlink(staging).catch(() => undefined);
      }

      return document;
    },
  };
}

let sequence = 0;
function counter(): number {
  sequence += 1;
  return sequence;
}
