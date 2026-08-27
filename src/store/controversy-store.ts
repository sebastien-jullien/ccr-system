/**
 * Journal V3 des controverses — lecture, append, révision de domaine.
 *
 * Tranche S2 du plan gelé. Ce module fournit la **source stable** ; il ne
 * construit aucune projection métier (S3) et n'arbitre aucune autorité
 * d'écriture (S4).
 *
 * ## Réutilisation, pas réinvention
 *
 * La mécanique JSONL est celle du dépôt, sans variante :
 *
 * ```text
 * écriture   appendJsonLine — une ligne JSON complète, terminée
 * lecture    readJsonlJournal — tolérance à la SEULE queue non terminée
 * ```
 *
 * Les garanties héritées sont exactement celles du lecteur commun pour les
 * lignes **terminées** : une ligne terminée invalide est une corruption
 * **stable** et échoue immédiatement, qu'elle soit médiane ou finale. V3
 * n'assouplit rien de ce côté.
 *
 * ## Le saut de ligne fait l'écriture
 *
 * Le contrat V3 §16.5 pose deux choses ensemble :
 *
 * ```text
 * append   une entrée est écrite comme une ligne JSON complète TERMINÉE
 *          par un saut de ligne
 * lecture  un fragment final non terminé est ignoré comme NON ENCORE ÉCRIT
 * ```
 *
 * Le saut de ligne est donc ce qui fait l'écriture, et un fragment qui ne le
 * porte pas n'est pas une entrée — ni valide, ni invalide, ni corrompue :
 * absente. Le contrat le dit explicitement, « jamais une corruption ».
 *
 * V3 tronque donc sa lecture au dernier saut de ligne **avant** de la confier au
 * lecteur commun, qui ne voit plus qu'un document intégralement terminé. Le
 * moteur JSONL n'est ni modifié, ni réimplémenté : il conserve son analyse, sa
 * validation et son refus des lignes terminées invalides. Seule la frontière de
 * ce qui est « écrit » est posée en amont, et elle l'est pour V3 seul — les six
 * autres journaux gardent leur sémantique intacte.
 *
 * ## Absence et vide ne sont pas le même fait
 *
 * ```text
 * fichier absent   run antérieur à V3, ou run sans aucune entrée écrite
 * fichier vide     le journal existe et ne contient rien
 * ```
 *
 * Les deux portent zéro entrée, et les confondre serait commode. Le contrat
 * l'interdit : la révision doit rester honnête sur ce qui a été observé, et
 * lire un run antérieur à V3 ne doit jamais matérialiser son journal.
 */

import { createHash } from 'node:crypto';
import { readFile, truncate } from 'node:fs/promises';

import { validateControversyEntry } from '../core/controversy.ts';
import type { ControversyEntry } from '../core/controversy.ts';
import { appendJsonLine } from './atomic-file.ts';
import { parseJournalLine, readJsonlJournal } from './jsonl-journal.ts';
import type { ReadJournalOptions } from './jsonl-journal.ts';
import type { RunPaths } from './layout.ts';

const JOURNAL_NAME = 'controversies.jsonl';

/** Seams de lecture, transmis tels quels au lecteur commun. */
export type ControversyJournalSeams = Omit<ReadJournalOptions<ControversyEntry>, 'parseLine'>;

// --------------------------------------------------------------------------
// Révision de domaine
// --------------------------------------------------------------------------

/**
 * Espace de noms de la révision V3.
 *
 * Le préfixe est **visiblement** distinct de celui d'une révision de run, et le
 * domaine entre dans l'empreinte elle-même. Un jeton V3 ne peut donc être
 * confondu avec un jeton de run ni par un lecteur humain, ni par une
 * comparaison de chaînes.
 */
const CONTROVERSY_REVISION_SCHEME = 'ctv-sha256';
const CONTROVERSY_REVISION_DOMAIN = 'ccr-controversy-revision/1\n';

/**
 * Contenu observé de la source V3.
 *
 * `present: false` n'est pas une erreur : c'est l'état normal d'un run qui n'a
 * jamais rien enregistré, y compris tout run antérieur à V3.
 */
export type ControversySourceContent =
  | { readonly present: false }
  /**
   * `written` est le **préfixe terminé** du fichier, jamais ses octets bruts :
   * ce qui porte un saut de ligne, et rien d'autre. Un append en vol ne fait
   * donc pas bouger la révision — il n'a encore rien écrit.
   */
  | { readonly present: true; readonly written: string };

/**
 * Révision du journal V3 — **fondée sur le contenu**, jamais sur les
 * métadonnées.
 *
 * C'est la règle déjà posée par le snapshot natif : les signatures physiques
 * servent à détecter une course, elles n'entrent jamais dans une révision, car
 * un fichier recopié à contenu identique doit produire la même empreinte. La
 * présence, elle, est un fait du contenu observé et non une métadonnée : un
 * journal absent et un journal vide n'ont pas été observés dans le même état.
 *
 * Aucun horodatage, aucun compteur mutable, aucune valeur fabriquée par un
 * client : le jeton vient du snapshot, et le client le renvoie tel quel.
 */
export function computeControversyRevision(source: ControversySourceContent): string {
  const digest = createHash('sha256');
  digest.update(CONTROVERSY_REVISION_DOMAIN);
  if (source.present) {
    digest.update(`present:${String(source.written.length)}:${source.written}`);
  } else {
    // Marqueur d'absence, distinct d'un contenu vide — que `present:0:` code
    // déjà, et qui ne doit pas lui être équivalent.
    digest.update('absent');
  }
  return `${CONTROVERSY_REVISION_SCHEME}:${digest.digest('hex')}`;
}

// --------------------------------------------------------------------------
// Lecture
// --------------------------------------------------------------------------

/** Ce qu'une lecture du journal V3 établit, et rien de plus. */
export interface ControversyJournalRead {
  /** La source existe-t-elle ? L'absence est un état normal. */
  readonly present: boolean;
  /** Entrées valides, dans l'ordre d'append — jamais retriées. */
  readonly entries: readonly ControversyEntry[];
  /** Jeton de fraîcheur du domaine V3. */
  readonly revision: string;
  /**
   * Taille en octets du préfixe **écrit** — ce qui porte un saut de ligne.
   *
   * État physique, pas projection métier : c'est la frontière exacte à partir
   * de laquelle un append doit reprendre.
   */
  readonly written_bytes: number;
  /**
   * Des octets suivent-ils le dernier saut de ligne ?
   *
   * Contractuellement non écrits, donc absents des entrées et de la révision —
   * mais physiquement présents, et un append naïf les concaténerait.
   */
  readonly has_unwritten_tail: boolean;
}

function parseControversyLine(line: string, lineNumber: number): ControversyEntry {
  return validateControversyEntry(
    parseJournalLine(line, lineNumber, JOURNAL_NAME) as ControversyEntry,
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
 * Lit le journal V3 et calcule sa révision depuis **la même** lecture.
 *
 * Le contenu est capturé par la couture de lecture du lecteur commun : calculer
 * la révision depuis un second `readFile` autoriserait une divergence entre les
 * entrées rendues et l'empreinte qui prétend les décrire.
 *
 * La révision porte exactement le préfixe qui a produit ces entrées. Elle ne
 * prétend jamais couvrir des octets que la lecture considère non écrits.
 *
 * Ne crée jamais le fichier. Ne le normalise jamais. Une absence est rendue
 * comme telle.
 */
export async function readControversyJournal(
  paths: RunPaths,
  seams: ControversyJournalSeams = {},
): Promise<ControversyJournalRead> {
  const read = seams.read ?? ((target: string): Promise<string> => readFile(target, 'utf8'));

  let observed: ControversySourceContent = { present: false };
  let writtenBytes = 0;
  let unwrittenTail = false;
  const records = await readJsonlJournal<ControversyEntry>(paths.controversies, {
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
        // Le lecteur commun traite déjà `ENOENT` comme un journal vide. On
        // note l'absence ici, à l'endroit où elle est constatée, puis on lui
        // laisse sa propre sémantique.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          observed = { present: false };
          writtenBytes = 0;
          unwrittenTail = false;
        }
        throw error;
      }
    },
    parseLine: parseControversyLine,
  });

  return {
    present: observed.present,
    entries: records.map((record) => record.value),
    revision: computeControversyRevision(observed),
    written_bytes: writtenBytes,
    has_unwritten_tail: unwrittenTail,
  };
}

// --------------------------------------------------------------------------
// Écriture
// --------------------------------------------------------------------------

/**
 * Ajoute une entrée **déjà validée** en fin de journal.
 *
 * Primitive de bas niveau, délibérément dépourvue de sémantique métier : elle
 * ne décide pas qui a le droit de produire cette entrée, ne vérifie aucune
 * cible dans le journal, ne résout aucun ancrage textuel. Ces questions
 * appartiennent au service de S4, qui seul dispose du contexte.
 *
 * ## Un octet non écrit ne doit pas devenir une corruption
 *
 * `appendJsonLine` ouvre en mode `'a'` : il écrit à la fin des octets présents,
 * qu'ils portent un saut de ligne ou non. Sur un journal terminé par un
 * fragment non écrit, il produirait donc une ligne **concaténée** — et cette
 * ligne, elle, serait terminée, donc une corruption stable.
 *
 * Le contrat qualifie déjà ce fragment de non écrit. Le retirer avant d'écrire
 * ne supprime donc **aucune entrée autoritaire** : ce n'est pas une réécriture
 * d'histoire, c'est refuser de promouvoir en histoire ce qui n'en fait pas
 * partie.
 *
 * ```text
 * lire et VALIDER le journal autoritaire
 * → si une corruption terminée existe : REFUS, fichier intact
 * → sinon, si des octets non écrits traînent : les retirer
 * → puis seulement, écrire la nouvelle ligne complète
 * ```
 *
 * ## Reprise après interruption
 *
 * ```text
 * avant la normalisation   état précédent inchangé
 * après, avant l'append    préfixe valide seul — seuls des octets NON ÉCRITS
 *                          ont disparu
 * pendant l'append         nouvelle queue non terminée, donc non écrite ;
 *                          le préfixe reste lisible
 * après l'append           la ligne est autoritaire
 * ```
 *
 * Aucune étape ne transforme en corruption terminée un journal dont la partie
 * autoritaire était valide.
 *
 * ## Précondition de sérialisation
 *
 * La séquence lire → normaliser → écrire n'est **pas** atomique entre
 * processus. Cette primitive ne prend aucun verrou et n'en promet aucun :
 *
 * > **Tout usage de mutation métier exige que l'appelant détienne le run lock.**
 *
 * C'est le câblage prévu pour S4 ; ce n'est pas une anticipation, c'est la
 * précondition technique de la primitive.
 */
export async function appendControversyEntry(
  paths: RunPaths,
  entry: ControversyEntry,
  seams: ControversyJournalSeams = {},
): Promise<ControversyEntry> {
  const validated = validateControversyEntry(entry);

  // Lecture d'abord : elle lève sur toute corruption terminée, toute version
  // non supportée, toute entrée invalide. Aucun octet n'est touché tant que le
  // journal autoritaire n'est pas établi comme lisible.
  const current = await readControversyJournal(paths, seams);

  if (current.has_unwritten_tail) {
    await truncate(paths.controversies, current.written_bytes);
  }

  await appendJsonLine(paths.controversies, validated);
  return validated;
}
