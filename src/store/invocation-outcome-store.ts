/**
 * Source canonique des issues négatives terminales d'invocation.
 *
 * ## Pourquoi un document atomique, et pas un journal
 *
 * `appendJsonLine` écrit une ligne puis la synchronise, mais l'écriture d'une
 * ligne n'est **pas** atomique — `jsonl-journal.ts` le pose lui-même. Un crash
 * pendant un append laisse une queue partielle **stable**, et le lecteur, qui
 * ne rend jamais « seulement ce qui était valide avant l'erreur », déclare
 * alors le journal entier invalide.
 *
 * Un fait d'issue commité hier deviendrait donc illisible à cause d'un crash
 * survenu aujourd'hui. Le contrat gelé exige l'inverse.
 *
 * `writeJsonAtomic` — temporaire, `fsync`, `rename` tout-ou-rien — supprime
 * cette classe entière : un lecteur observe toujours un document **complet**,
 * l'ancien ou le nouveau.
 *
 * ```text
 * GARANTIES REVENDIQUÉES   celles de writeJsonAtomic, et rien de plus
 * NON REVENDIQUÉ           résistance à la coupure d'alimentation,
 *                          garantie au niveau du périphérique,
 *                          durabilité transactionnelle inter-machines
 * ```
 *
 * `syncDirectory` est un no-op sous Windows, et laisse sous POSIX une fenêtre
 * étroite entre le `rename` et le `fsync` du répertoire. Ce module n'affirme
 * rien au-delà.
 *
 * ## Immutabilité
 *
 * Le document est physiquement réécrit à chaque ajout. L'immutabilité d'un
 * fait est donc un **invariant applicatif**, imposé ici — n'ajouter jamais
 * qu'une entrée, ne modifier jamais une entrée existante — et non une propriété
 * structurelle du support comme elle l'est pour un journal append-only. Le
 * distinguer est plus honnête que de laisser croire à une garantie de forme.
 *
 * ## Sérialisation
 *
 * Ce module **ne prend aucun verrou**. La séquence lecture → vérification →
 * écriture n'est sûre que si son appelant la place dans une seule détention du
 * verrou de run. Le verrou n'étant pas réentrant, cette décision appartient à
 * l'appelant, qui seul sait s'il en détient déjà un.
 *
 * ## Absence ≠ vide ≠ corruption
 *
 * ```text
 * fichier absent      aucun fait négatif  →  AUCUNE conclusion par elle-même
 * document valide     les faits qu'il porte
 * document illisible  CORRUPTION DE PERSISTANCE  →  lève, jamais « vide »
 * ```
 *
 * Aucun marqueur de naissance : contrairement au ledger d'invocations, dont
 * l'absence change la lecture du quota, ici « fichier absent » et « document
 * vide » commandent exactement la même sémantique — aucune conclusion. Un
 * marqueur ne répondrait à aucune question dont la réponse changerait.
 */

import { CcrError } from '../core/errors.ts';
import {
  emptyInvocationOutcomeDocument,
  INVOCATION_OUTCOME_SCHEMA_VERSION,
  validateInvocationOutcomeDocument,
  validateInvocationOutcomeRecord,
} from '../core/invocation-outcome.ts';
import type {
  InvocationOutcomeDocument,
  InvocationOutcomeRecord,
  TerminalNegativeOutcome,
} from '../core/invocation-outcome.ts';
import { readJsonFile, writeJsonAtomic } from './atomic-file.ts';
import type { RunPaths } from './layout.ts';

/**
 * Lit le document d'issues.
 *
 * `ENOENT` rend le document vide — c'est le cas normal d'un run qui n'a jamais
 * connu d'issue négative, et de tout run antérieur à cette source. Toute autre
 * erreur, y compris un JSON illisible, est propagée : une corruption ne se
 * requalifie jamais en absence.
 */
export async function readInvocationOutcomes(paths: RunPaths): Promise<InvocationOutcomeDocument> {
  let raw: unknown;
  try {
    raw = await readJsonFile(paths.invocationOutcomes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyInvocationOutcomeDocument();
    throw error;
  }
  return validateInvocationOutcomeDocument(raw);
}

/** L'issue négative durable d'une invocation, si elle existe. */
export function findInvocationOutcome(
  document: InvocationOutcomeDocument,
  invocationId: string,
): InvocationOutcomeRecord | undefined {
  return document.outcomes.find((outcome) => outcome.invocation_id === invocationId);
}

/**
 * Ajoute une issue négative et rend l'enregistrement écrit.
 *
 * **L'appelant doit détenir le verrou de run.** Ce module ne l'acquiert pas et
 * ne vérifie pas qu'il est détenu : le verrou n'est pas réentrant, et le
 * prendre ici casserait tout appelant qui en détient déjà un.
 *
 * Refuse une seconde issue pour la même invocation. Le refus est antérieur à
 * toute écriture : le document existant reste intact, et le fait d'origine
 * n'est jamais remplacé.
 */
export async function appendInvocationOutcome(
  paths: RunPaths,
  invocationId: string,
  outcome: TerminalNegativeOutcome,
  recordedAt: string,
): Promise<InvocationOutcomeRecord> {
  const current = await readInvocationOutcomes(paths);

  if (findInvocationOutcome(current, invocationId) !== undefined) {
    throw new CcrError(
      'INVOCATION_OUTCOME_ALREADY_RECORDED',
      `L'invocation ${invocationId} porte déjà une issue négative durable. ` +
        "Une issue enregistrée n'est jamais remplacée.",
      { details: { invocationId } },
    );
  }

  const record = validateInvocationOutcomeRecord({
    schema_version: INVOCATION_OUTCOME_SCHEMA_VERSION,
    invocation_id: invocationId,
    recorded_at: recordedAt,
    terminal_negative_outcome: outcome,
  });

  const next: InvocationOutcomeDocument = {
    schema_version: INVOCATION_OUTCOME_SCHEMA_VERSION,
    outcomes: [...current.outcomes, record],
  };

  try {
    await writeJsonAtomic(paths.invocationOutcomes, next);
  } catch (cause) {
    throw new CcrError(
      'INVOCATION_OUTCOME_WRITE_FAILED',
      `L'issue négative de l'invocation ${invocationId} n'a pas pu être persistée. ` +
        "Le résultat négatif n'est pas rendu comme s'il avait été durablement enregistré.",
      { details: { invocationId, path: paths.invocationOutcomes }, cause },
    );
  }

  return record;
}
