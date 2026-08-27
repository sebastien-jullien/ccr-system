/**
 * Journal V5 du Reconciliation Engine — lecture, append, révision de domaine.
 *
 * Tranche S2 du plan gelé. Ce module fournit la **source stable** ; il ne
 * construit aucune projection (S12), n'observe aucun instantané (S3), n'arbitre
 * aucune autorité d'écriture (S5) et ne dérive aucune actualité (S9).
 *
 * ```text
 * PERSISTED HISTORY   ≠   DERIVED CURRENTNESS
 * STORE               ≠   BUSINESS AUTHORITY
 * ```
 *
 * ## Ce que ce module ne décide jamais
 *
 * Quel acte est courant, quelle clôture est en vigueur, quel désaccord subsiste,
 * quelle proposition mérite d'être suivie. Aucune de ces questions n'a de
 * réponse ici, et aucune fonction de ce fichier ne s'appelle `close`,
 * `reopen`, `supersede` ou `resolve`. L'API est mécanique : lire, ajouter,
 * mesurer.
 *
 * ## Journal dédié
 *
 * Le contrat §27.1 exige un journal propre au moteur. Aucun enregistrement V5 ne
 * rejoint `events.jsonl`, `controversies.jsonl`, `evidence.jsonl` ni
 * `decisions.jsonl` ; aucun de ces journaux n'est lu, écrit ou muté ici.
 *
 * ## Réutilisation, pas réinvention
 *
 * La mécanique JSONL est celle de `jsonl-journal.ts`, sans variante : même
 * lecteur commun, même doctrine d'absence, même tolérance — la **seule** queue
 * non terminée. Ce qui change est ce que chaque ligne signifie, et cela vit dans
 * `core/reconciliation.ts`.
 *
 * ```text
 * lecture     readJsonlJournal — tolérance à la SEULE queue non terminée
 * validation  validateReconciliationEntry — le domaine S1, jamais une copie
 * ```
 *
 * ## Le saut de ligne fait l'écriture
 *
 * ```text
 * seul le fragment final non terminé est traité comme non encore écrit
 * une ligne TERMINÉE invalide est une corruption stable, jamais une fin de journal
 * un refus ne crée jamais le fichier
 * ```
 *
 * ## Une seule séquence, strictement croissante
 *
 * Le contrat §4 exige l'unicité de `rcn_` **par run**, toutes classes
 * confondues : une proposition, un acte humain et une réponse puisent dans la
 * même séquence. Une séquence qui reculerait ou se répéterait n'est pas un
 * doublon métier — c'est une **corruption d'identité canonique**, et elle est
 * refusée à la lecture.
 *
 * Deux actes de contenu identique, eux, coexistent parfaitement : CCR ne possède
 * aucune autorité d'équivalence, et deux gestes humains identiques sont deux
 * faits historiques. **Aucune déduplication métier n'existe ici.**
 *
 * ## Aucune règle de continuité
 *
 * L'allocation naturelle depuis l'état autoritaire produit des identifiants
 * contigus, mais ce n'est qu'une propriété d'implémentation : le contrat exige
 * l'unicité et la croissance stricte, **jamais** l'absence de trou. Un append
 * refusé ou un processus interrompu ne crée aucune obligation de réécrire
 * l'histoire pour combler quoi que ce soit.
 *
 * ```text
 * ID ORDER  ≠  PRIORITY  ≠  CURRENTNESS  ≠  MERITS
 * ```
 */

import { createHash } from 'node:crypto';
import { open, readFile, truncate } from 'node:fs/promises';

import {
  parseReconciliationSequence,
  validateReconciliationEntry,
} from '../core/reconciliation.ts';
import type { ReconciliationEntry } from '../core/reconciliation.ts';
import { CcrError } from '../core/errors.ts';
import { parseJournalLine, readJsonlJournal } from './jsonl-journal.ts';
import type { ReadJournalOptions } from './jsonl-journal.ts';
import type { RunPaths } from './layout.ts';

const JOURNAL_NAME = 'reconciliations.jsonl';

/** Seams de lecture, transmis tels quels au lecteur commun. */
export type ReconciliationJournalSeams = Omit<ReadJournalOptions<ReconciliationEntry>, 'parseLine'>;

// --------------------------------------------------------------------------
// Révision de domaine
// --------------------------------------------------------------------------

/**
 * Espace de noms de la révision V5.
 *
 * Quatre espaces coexistent et ne se comparent **jamais** : `sha256:` pour
 * l'état opérationnel du run, `ctv-sha256:` pour le journal des controverses,
 * `ev-sha256:` pour celui de l'evidence, `rcn-sha256:` ici. Le domaine entre
 * dans l'empreinte elle-même, si bien qu'un jeton V5 ne peut être confondu avec
 * un autre ni par un lecteur humain, ni par une comparaison de chaînes.
 *
 * Une égalité d'empreintes entre deux domaines n'aurait aucune signification, et
 * aucune fonction de ce module n'en établit une.
 *
 * ```text
 * REVISION  ≠  MERITS        REVISION  ≠  CURRENTNESS
 * ```
 *
 * Le jeton mesure le contenu observé. Il n'encode ni actualité, ni clôture, ni
 * priorité, ni convergence.
 */
const RECONCILIATION_REVISION_SCHEME = 'rcn-sha256';
const RECONCILIATION_REVISION_DOMAIN = 'ccr-reconciliation-revision/1\n';

/**
 * Contenu observé de la source V5.
 *
 * `present: false` n'est pas une erreur : c'est l'état normal de tout run
 * antérieur à V5, et de tout run natif qui n'a jamais rien enregistré.
 */
export type ReconciliationSourceContent =
  | { readonly present: false }
  /**
   * `written` est le **préfixe terminé** du fichier, jamais ses octets bruts :
   * ce qui porte un saut de ligne, et rien d'autre. Un append en vol ne fait
   * donc pas bouger la révision — il n'a encore rien écrit.
   */
  | { readonly present: true; readonly written: string };

/**
 * Révision du journal V5 — **fondée sur le contenu**, jamais sur les métadonnées.
 *
 * Un fichier recopié à contenu identique produit la même empreinte : les
 * signatures physiques servent à détecter une course, elles n'entrent jamais
 * dans une révision.
 *
 * ```text
 * ABSENT  ≠  PRESENT-EMPTY
 * ```
 *
 * La présence est un fait du contenu observé : un journal absent et un journal
 * vide n'ont pas été observés dans le même état, et le marqueur `absent` est
 * distinct de `present:0:` — que le second code déjà. Un fichier absent ne
 * signifie **pas** « aucun acte n'a jamais existé » : il signifie que cette
 * source n'a pas été matérialisée dans ce run.
 *
 * ```text
 * UNKNOWN  ≠  ZERO           PRE_LEDGER  ≠  ZERO HISTORICAL ACTIVITY
 * ```
 */
export function computeReconciliationRevision(source: ReconciliationSourceContent): string {
  const digest = createHash('sha256');
  digest.update(RECONCILIATION_REVISION_DOMAIN);
  if (source.present) {
    digest.update(`present:${String(source.written.length)}:${source.written}`);
  } else {
    digest.update('absent');
  }
  return `${RECONCILIATION_REVISION_SCHEME}:${digest.digest('hex')}`;
}

// --------------------------------------------------------------------------
// Lecture
// --------------------------------------------------------------------------

/** Ce qu'une lecture du journal V5 établit, et rien de plus. */
export interface ReconciliationJournalRead {
  /** La source existe-t-elle ? L'absence est un état normal. */
  readonly present: boolean;
  /**
   * Entrées valides, dans l'ordre d'append — **jamais retriées**.
   *
   * Une seule liste : séparer les trois classes serait une projection, et le
   * regroupement appartient au read model, qui n'existe pas encore.
   */
  readonly entries: readonly ReconciliationEntry[];
  /** Jeton de fraîcheur du domaine V5. Ce module le PRODUIT ; il ne l'impose pas. */
  readonly revision: string;
  /**
   * Taille en octets du préfixe **écrit** — ce qui porte un saut de ligne.
   *
   * État physique, pas projection : c'est la frontière exacte à partir de
   * laquelle un append doit reprendre.
   */
  readonly written_bytes: number;
  /**
   * Des octets suivent-ils le dernier saut de ligne ?
   *
   * Contractuellement non écrits, donc absents des entrées, de la révision et
   * de la séquence — mais physiquement présents, et un append naïf les
   * concaténerait.
   */
  readonly has_unwritten_tail: boolean;
  /**
   * Prochaine séquence disponible, **dérivée du journal canonique**.
   *
   * Aucun compteur parallèle n'est persisté : le journal est l'autorité, et un
   * second compteur pourrait en diverger. Un fragment non écrit ne consomme
   * aucune séquence, puisqu'il n'a rien écrit.
   *
   * Ce module **calcule** la prochaine séquence ; il n'attribue aucune identité
   * et ne prend aucun verrou. L'allocation effective appartient au service qui
   * détient le verrou de run.
   */
  readonly next_sequence: number;
}

function journalInvalid(message: string, details: Record<string, unknown>): CcrError {
  return new CcrError('JOURNAL_INVALID', `${JOURNAL_NAME} : ${message}`, { details });
}

function parseReconciliationLine(line: string, lineNumber: number): ReconciliationEntry {
  return validateReconciliationEntry(
    parseJournalLine(line, lineNumber, JOURNAL_NAME) as ReconciliationEntry,
  );
}

/**
 * Découpe au dernier saut de ligne : ce qui est écrit, et rien de plus.
 *
 * Même règle que le lecteur commun applique en interne, appliquée ici en amont
 * pour que le fragment non terminé ne lui parvienne jamais.
 */
function writtenPrefix(raw: string): string {
  const lastNewline = raw.lastIndexOf('\n');
  return lastNewline === -1 ? '' : raw.slice(0, lastNewline + 1);
}

/**
 * Vérifie que la séquence progresse strictement, et rend la prochaine.
 *
 * Un identifiant répété ou décroissant rendrait deux entrées indiscernables et
 * ferait réattribuer une identité déjà prise. Ce n'est pas un doublon métier —
 * qui est légitime — mais une corruption de l'identité canonique, et elle est
 * refusée sans réparation ni saut.
 *
 * Une **seule** séquence gouverne les trois classes : le contrat §4 exige
 * l'unicité de `rcn_` par run, pas par sorte d'enregistrement.
 */
function assertStrictlyIncreasing(
  records: readonly { readonly lineNumber: number; readonly value: ReconciliationEntry }[],
): number {
  let highest = 0;

  for (const record of records) {
    const parsed = parseReconciliationSequence(record.value.entry_id);
    if (parsed === undefined || parsed <= highest) {
      throw journalInvalid(
        `ligne ${String(record.lineNumber)} : séquence non strictement croissante (${record.value.entry_id}).`,
        { line: record.lineNumber, entryId: record.value.entry_id, previous: highest, kind: record.value.kind },
      );
    }
    highest = parsed;
  }

  return highest;
}

/**
 * Lit le journal V5 et calcule sa révision depuis **la même** lecture.
 *
 * Calculer la révision depuis un second `readFile` autoriserait une divergence
 * entre les entrées rendues et l'empreinte qui prétend les décrire.
 *
 * Ne crée jamais le fichier. Ne le normalise jamais. Une absence est rendue
 * comme telle — et une corruption lève, elle ne devient jamais un journal vide.
 *
 * ```text
 * CORRUPT  ≠  ABSENT        CORRUPT  ≠  PRESENT_EMPTY
 * ```
 */
export async function readReconciliationJournal(
  paths: RunPaths,
  seams: ReconciliationJournalSeams = {},
): Promise<ReconciliationJournalRead> {
  const read = seams.read ?? ((target: string): Promise<string> => readFile(target, 'utf8'));

  let observed: ReconciliationSourceContent = { present: false };
  let writtenBytes = 0;
  let unwrittenTail = false;

  const records = await readJsonlJournal<ReconciliationEntry>(paths.reconciliations, {
    ...seams,
    read: async (target: string): Promise<string> => {
      try {
        const raw = await read(target);
        const written = writtenPrefix(raw);
        observed = { present: true, written };
        writtenBytes = Buffer.byteLength(written, 'utf8');
        unwrittenTail = written.length !== raw.length;
        // Le lecteur commun ne reçoit qu'un document terminé : il n'a donc
        // aucun fragment à relire, et aucun à refuser.
        return written;
      } catch (error) {
        // Le lecteur commun traite déjà `ENOENT` comme un journal vide. On note
        // l'absence ici, à l'endroit où elle est constatée, puis on lui laisse
        // sa propre sémantique. Toute autre erreur remonte telle quelle : une
        // lecture impossible n'est jamais un journal vide.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          observed = { present: false };
          writtenBytes = 0;
          unwrittenTail = false;
        }
        throw error;
      }
    },
    parseLine: parseReconciliationLine,
  });

  const highest = assertStrictlyIncreasing(records);

  return {
    present: observed.present,
    entries: records.map((record) => record.value),
    revision: computeReconciliationRevision(observed),
    written_bytes: writtenBytes,
    has_unwritten_tail: unwrittenTail,
    next_sequence: highest + 1,
  };
}

// --------------------------------------------------------------------------
// Écriture
// --------------------------------------------------------------------------

/**
 * Écrit N lignes JSON terminées en **une seule** opération.
 *
 * Même forme de lot que V4, et pour la même raison : le contrat exige qu'un lot
 * de propositions soit écrit sans état intermédiaire partiel. Elle vit ici
 * plutôt que dans `atomic-file.ts` parce que le besoin est propre au journal
 * V5 ; ajouter une variante à une primitive partagée pour un besoin qui ne
 * l'est pas la changerait pour tous.
 *
 * La sérialisation est `JSON.stringify` sur l'entrée **validée**, sans
 * réordonnancement de clés, sans normalisation de contenu, sans trim : le
 * contenu humain traverse octet pour octet, et l'ordre des options est celui du
 * producteur.
 *
 * ```text
 * CANONICAL ORDER  ≠  MERITS ORDER
 * ```
 */
async function appendJsonLines(file: string, records: readonly unknown[]): Promise<void> {
  const payload = records.map((record) => `${JSON.stringify(record)}\n`).join('');
  const handle = await open(file, 'a');
  try {
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Ajoute un lot d'entrées **déjà construites** en fin de journal.
 *
 * Primitive de bas niveau, délibérément dépourvue de sémantique métier : elle ne
 * décide pas qui a le droit de produire ces entrées, ne résout aucune cible, ne
 * valide aucune appartenance de périmètre, ne vérifie aucune fraîcheur, ne juge
 * aucune supersession et n'attribue aucune identité. Ces questions appartiennent
 * aux services qui disposent d'un instantané et d'un verrou.
 *
 * ## Tout ou rien avant le premier octet
 *
 * Les entrées sont validées **intégralement** avant toute écriture, et le lot
 * part en une seule opération. Un lot dont une seule entrée est invalide ne
 * laisse donc aucune trace — pas même partielle.
 *
 * ## Un octet non écrit ne doit pas devenir une corruption
 *
 * L'append écrit à la fin des octets présents, qu'ils portent un saut de ligne
 * ou non. Sur un journal terminé par un fragment non écrit, il produirait une
 * ligne **concaténée** — et celle-là, terminée, serait une corruption stable.
 *
 * Le contrat qualifie déjà ce fragment de non écrit. Le retirer ne supprime donc
 * aucune entrée autoritaire : ce n'est pas une réécriture d'histoire, c'est
 * refuser de promouvoir en histoire ce qui n'en fait pas partie.
 *
 * ```text
 * valider le lot
 * → lire et VALIDER le journal autoritaire
 * → si une corruption terminée existe : REFUS, fichier intact
 * → sinon, si des octets non écrits traînent : les retirer
 * → puis seulement, écrire le lot complet
 * ```
 *
 * ## Précondition de sérialisation
 *
 * La séquence lire → normaliser → écrire n'est **pas** atomique entre processus.
 * Cette primitive ne prend aucun verrou et n'en promet aucun :
 *
 * > **Tout usage de mutation métier exige que l'appelant détienne le run lock.**
 */
export async function appendReconciliationEntries(
  paths: RunPaths,
  entries: readonly ReconciliationEntry[],
  seams: ReconciliationJournalSeams = {},
): Promise<readonly ReconciliationEntry[]> {
  if (entries.length === 0) {
    throw new CcrError('INVALID_ARGUMENT', `${JOURNAL_NAME} : un lot vide ne s'écrit pas.`);
  }

  const validated = entries.map((entry) => validateReconciliationEntry(entry));

  // Lecture d'abord : elle lève sur toute corruption terminée, toute version non
  // supportée, toute séquence non croissante. Aucun octet n'est touché tant que
  // le journal autoritaire n'est pas établi comme lisible.
  const current = await readReconciliationJournal(paths, seams);

  // Le lot doit CONTINUER la séquence du journal, strictement.
  //
  // Sans ce contrôle, un lot bien formé mais portant deux fois la même identité
  // — ou une identité déjà écrite — s'écrirait sans erreur, et le journal
  // deviendrait illisible au prochain `read`. Un magasin qui écrit ce qu'il
  // refusera de relire fabrique la corruption qu'il prétend interdire.
  //
  // Contrôle **structurel**, et rien de plus : il ne dit pas qui avait le droit
  // d'écrire, ni si l'acte est opportun. L'allocation elle-même appartient au
  // service qui détient le verrou.
  let previous = current.next_sequence - 1;
  for (const [index, entry] of validated.entries()) {
    const sequence = parseReconciliationSequence(entry.entry_id);
    if (sequence === undefined || sequence <= previous) {
      throw journalInvalid(
        `lot refusé : ${entry.entry_id} ne poursuit pas strictement la séquence du journal.`,
        { position: index, entryId: entry.entry_id, previous },
      );
    }
    previous = sequence;
  }

  if (current.has_unwritten_tail) {
    await truncate(paths.reconciliations, current.written_bytes);
  }

  await appendJsonLines(paths.reconciliations, validated);
  return validated;
}
