/**
 * Journal V4 de l'Evidence Engine — lecture, append, révision de domaine.
 *
 * Tranche S2 du plan gelé. Ce module fournit la **source stable** ; il ne
 * construit aucune projection (S3) et n'arbitre aucune autorité d'écriture (S4).
 *
 * ## Réutilisation, pas réinvention
 *
 * La mécanique est celle de `controversy-store.ts`, sans variante : même lecteur
 * commun, même frontière d'écriture, même doctrine d'absence. Ce qui change est
 * ce que chaque ligne signifie, et cela vit dans `core/evidence.ts`.
 *
 * ```text
 * lecture    readJsonlJournal — tolérance à la SEULE queue non terminée
 * validation validateEvidenceEntry — le domaine S1, jamais une seconde copie
 * ```
 *
 * ## Le saut de ligne fait l'écriture
 *
 * Le contrat V4 §14.3 reprend la discipline V3 sans altération :
 *
 * ```text
 * seul le fragment final non terminé est traité comme non encore écrit
 * une ligne TERMINÉE invalide est une corruption stable, jamais une fin de journal
 * un refus ne crée jamais le fichier
 * ```
 *
 * La lecture est donc tronquée au dernier saut de ligne **avant** d'être confiée
 * au lecteur commun, qui ne voit qu'un document intégralement terminé. Le moteur
 * JSONL n'est ni modifié, ni réimplémenté.
 *
 * ## Deux séquences, indépendantes et strictement croissantes
 *
 * Le contrat §8 exige que `mat_` et `add_` progressent séparément. Une séquence
 * qui reculerait ou se répéterait n'est pas un doublon métier : c'est une
 * **corruption d'identité canonique**, et elle est refusée à la lecture, comme
 * `decisions.jsonl` refuse déjà la sienne.
 *
 * Deux matériaux de charge identique, eux, coexistent parfaitement : CCR ne
 * possède aucune autorité d'équivalence, et deux adductions identiques sont
 * deux actes historiques. **Aucune déduplication métier n'existe ici.**
 */

import { createHash } from 'node:crypto';
import { open, readFile, truncate } from 'node:fs/promises';

import {
  parseAdductionSequence,
  parseMaterialSequence,
  validateEvidenceEntry,
} from '../core/evidence.ts';
import type { EvidenceEntry } from '../core/evidence.ts';
import { CcrError } from '../core/errors.ts';
import { parseJournalLine, readJsonlJournal } from './jsonl-journal.ts';
import type { ReadJournalOptions } from './jsonl-journal.ts';
import type { RunPaths } from './layout.ts';

const JOURNAL_NAME = 'evidence.jsonl';

/** Seams de lecture, transmis tels quels au lecteur commun. */
export type EvidenceJournalSeams = Omit<ReadJournalOptions<EvidenceEntry>, 'parseLine'>;

// --------------------------------------------------------------------------
// Révision de domaine
// --------------------------------------------------------------------------

/**
 * Espace de noms de la révision V4.
 *
 * Trois espaces coexistent et ne se comparent jamais : `sha256:` pour l'état
 * opérationnel du run, `ctv-sha256:` pour le journal des controverses,
 * `ev-sha256:` ici. Le domaine entre dans l'empreinte elle-même, si bien qu'un
 * jeton V4 ne peut être confondu avec un autre ni par un lecteur humain, ni par
 * une comparaison de chaînes.
 */
const EVIDENCE_REVISION_SCHEME = 'ev-sha256';
const EVIDENCE_REVISION_DOMAIN = 'ccr-evidence-revision/1\n';

/**
 * Contenu observé de la source V4.
 *
 * `present: false` n'est pas une erreur : c'est l'état normal de tout run
 * antérieur à V4, et de tout run natif qui n'a jamais rien enregistré.
 */
export type EvidenceSourceContent =
  | { readonly present: false }
  /**
   * `written` est le **préfixe terminé** du fichier, jamais ses octets bruts :
   * ce qui porte un saut de ligne, et rien d'autre. Un append en vol ne fait
   * donc pas bouger la révision — il n'a encore rien écrit.
   */
  | { readonly present: true; readonly written: string };

/**
 * Révision du journal V4 — **fondée sur le contenu**, jamais sur les
 * métadonnées.
 *
 * Un fichier recopié à contenu identique produit la même empreinte : les
 * signatures physiques servent à détecter une course, elles n'entrent jamais
 * dans une révision. La présence, elle, est un fait du contenu observé : un
 * journal absent et un journal vide n'ont pas été observés dans le même état.
 */
export function computeEvidenceRevision(source: EvidenceSourceContent): string {
  const digest = createHash('sha256');
  digest.update(EVIDENCE_REVISION_DOMAIN);
  if (source.present) {
    digest.update(`present:${String(source.written.length)}:${source.written}`);
  } else {
    // Marqueur d'absence, distinct d'un contenu vide — que `present:0:` code
    // déjà, et qui ne doit pas lui être équivalent.
    digest.update('absent');
  }
  return `${EVIDENCE_REVISION_SCHEME}:${digest.digest('hex')}`;
}

// --------------------------------------------------------------------------
// Lecture
// --------------------------------------------------------------------------

/** Ce qu'une lecture du journal V4 établit, et rien de plus. */
export interface EvidenceJournalRead {
  /** La source existe-t-elle ? L'absence est un état normal. */
  readonly present: boolean;
  /**
   * Entrées valides, dans l'ordre d'append — **jamais retriées**.
   *
   * Une seule liste : séparer matériaux et adductions serait une projection, et
   * le regroupement appartient au read model, qui n'existe pas encore.
   */
  readonly entries: readonly EvidenceEntry[];
  /** Jeton de fraîcheur du domaine V4. */
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
   * des séquences — mais physiquement présents, et un append naïf les
   * concaténerait.
   */
  readonly has_unwritten_tail: boolean;
  /**
   * Prochaines séquences disponibles, **dérivées du journal canonique**.
   *
   * Aucun compteur parallèle n'est persisté : le journal est l'autorité, et un
   * second compteur pourrait en diverger. Un fragment non écrit ne consomme
   * aucune séquence, puisqu'il n'a rien écrit.
   */
  readonly next_material_sequence: number;
  readonly next_adduction_sequence: number;
}

function journalInvalid(message: string, details: Record<string, unknown>): CcrError {
  return new CcrError('JOURNAL_INVALID', `${JOURNAL_NAME} : ${message}`, { details });
}

function parseEvidenceLine(line: string, lineNumber: number): EvidenceEntry {
  return validateEvidenceEntry(parseJournalLine(line, lineNumber, JOURNAL_NAME) as EvidenceEntry);
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
 * Vérifie que chaque espace de noms progresse strictement, et rend les
 * prochaines séquences.
 *
 * Un identifiant répété ou décroissant rendrait deux entrées indiscernables et
 * ferait réattribuer une identité déjà prise. Ce n'est pas un doublon métier —
 * qui est légitime — mais une corruption de l'identité canonique, et elle est
 * refusée sans réparation ni saut.
 */
function assertStrictlyIncreasing(
  records: readonly { readonly lineNumber: number; readonly value: EvidenceEntry }[],
): { material: number; adduction: number } {
  let material = 0;
  let adduction = 0;

  for (const record of records) {
    const entry = record.value;
    const isMaterial = entry.kind === 'MATERIAL_RECORDED';
    const parsed = isMaterial
      ? parseMaterialSequence(entry.entry_id)
      : parseAdductionSequence(entry.entry_id);
    const previous = isMaterial ? material : adduction;

    if (parsed === undefined || parsed <= previous) {
      throw journalInvalid(
        `ligne ${String(record.lineNumber)} : séquence non strictement croissante (${entry.entry_id}).`,
        { line: record.lineNumber, entryId: entry.entry_id, previous, kind: entry.kind },
      );
    }

    if (isMaterial) material = parsed;
    else adduction = parsed;
  }

  return { material, adduction };
}

/**
 * Lit le journal V4 et calcule sa révision depuis **la même** lecture.
 *
 * Calculer la révision depuis un second `readFile` autoriserait une divergence
 * entre les entrées rendues et l'empreinte qui prétend les décrire.
 *
 * Ne crée jamais le fichier. Ne le normalise jamais. Une absence est rendue
 * comme telle — et une corruption lève, elle ne devient jamais un journal vide.
 */
export async function readEvidenceJournal(
  paths: RunPaths,
  seams: EvidenceJournalSeams = {},
): Promise<EvidenceJournalRead> {
  const read = seams.read ?? ((target: string): Promise<string> => readFile(target, 'utf8'));

  let observed: EvidenceSourceContent = { present: false };
  let writtenBytes = 0;
  let unwrittenTail = false;
  const records = await readJsonlJournal<EvidenceEntry>(paths.evidence, {
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
    parseLine: parseEvidenceLine,
  });

  const sequences = assertStrictlyIncreasing(records);

  return {
    present: observed.present,
    entries: records.map((record) => record.value),
    revision: computeEvidenceRevision(observed),
    written_bytes: writtenBytes,
    has_unwritten_tail: unwrittenTail,
    next_material_sequence: sequences.material + 1,
    next_adduction_sequence: sequences.adduction + 1,
  };
}

// --------------------------------------------------------------------------
// Écriture
// --------------------------------------------------------------------------

/**
 * Écrit N lignes JSON terminées en **une seule** opération.
 *
 * Forme de lot de `appendJsonLine`, dont elle reprend exactement les drapeaux et
 * la synchronisation. Elle vit ici plutôt que dans `atomic-file.ts` parce que le
 * besoin est propre à V4 : le contrat exige qu'un lot de propositions soit écrit
 * sans état intermédiaire partiel, et six autres journaux n'ont aucun usage
 * d'une forme de lot. Ajouter une variante au module générique changerait une
 * primitive partagée pour un besoin qui ne l'est pas.
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
 * confronte aucune citation. Ces questions appartiennent au service de S4, qui
 * seul dispose du contexte.
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
export async function appendEvidenceEntries(
  paths: RunPaths,
  entries: readonly EvidenceEntry[],
  seams: EvidenceJournalSeams = {},
): Promise<readonly EvidenceEntry[]> {
  if (entries.length === 0) {
    throw new CcrError('INVALID_ARGUMENT', `${JOURNAL_NAME} : un lot vide ne s'écrit pas.`);
  }

  const validated = entries.map((entry) => validateEvidenceEntry(entry));

  // Lecture d'abord : elle lève sur toute corruption terminée, toute version non
  // supportée, toute séquence non croissante. Aucun octet n'est touché tant que
  // le journal autoritaire n'est pas établi comme lisible.
  const current = await readEvidenceJournal(paths, seams);

  if (current.has_unwritten_tail) {
    await truncate(paths.evidence, current.written_bytes);
  }

  await appendJsonLines(paths.evidence, validated);
  return validated;
}
