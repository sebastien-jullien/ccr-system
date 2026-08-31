/**
 * V4 — adduction probatoire assistée par modèle.
 *
 * Le plan gelé (§10) réunit **trois** responsabilités dans ce seul module, sur
 * le modèle de `controversy-detector.ts` : parseur pur, dispatch gouverné,
 * frontière de disponibilité. Les scinder créerait trois fichiers dont deux
 * n'auraient aucune responsabilité autonome.
 *
 * ```text
 * SECTION 1/3   S7-A   parseur strict de sortie modèle      — écrite
 * SECTION 2/3   S7-B   dispatch gouverné en trois phases    — écrite
 * SECTION 3/3   S7-C   frontière de disponibilité publique  — écrite
 * ```
 *
 * ```text
 * IMPLÉMENTÉ   ≠   DISPONIBLE
 * ```
 *
 * Les trois sections existent désormais, et la fonctionnalité reste
 * **indisponible**. Ce n'est pas un état transitoire mal fini : c'est la
 * distinction que la section 3/3 a pour seule raison d'être.
 */

// --------------------------------------------------------------------------
// Imports — un seul bloc, pour les trois sections
// --------------------------------------------------------------------------

import {
  EVIDENCE_SCHEMA_VERSION,
  MAX_INLINE_TEXT_BYTES,
  ORIENTATIONS,
  formatAdductionId,
  isControversyEntryTargetId,
  isMaterialId,
  materialIsHeld,
  parseAdductionSequence,
} from '../core/evidence.ts';
import type {
  AdductionRecordedEntry,
  MaterialRecordedEntry,
  Orientation,
} from '../core/evidence.ts';
import { CONTROVERSY_ENTRY_KINDS } from '../core/controversy.ts';
import type { ControversyEntry } from '../core/controversy.ts';
import { CcrError } from '../core/errors.ts';
import type { ExpertSlotId, ProviderKind } from '../core/expert.ts';
import type { NativeCcrEvent } from '../core/run-native.ts';
import { EVIDENCE_ADDUCTION_TRIGGER } from '../core/usage-governance.ts';
import type { AgentAdapter, AgentTurnResult } from '../adapters/agent-adapter.ts';
import { runPaths } from '../store/layout.ts';
import { openInvocationLedger } from '../store/invocation-ledger.ts';
import { openUsageLedger } from '../store/usage-ledger.ts';
import { appendEvidenceEntries, readEvidenceJournal } from '../store/evidence-store.ts';
import { readStableNativeRunSnapshot } from '../store/native-run-snapshot.ts';
import type { NativeRunSnapshot } from '../store/native-run-snapshot.ts';
import { utf8ByteLength } from './transfer.ts';
import { assertInvocationQuotaAvailable } from './invocation-quota.ts';
import { createUsageRecorder, recordTurnUsage } from './usage-governance-writer.ts';
import { projectControversyReadModel } from './controversy-read-model.ts';
import { runtimeSettingsOf } from './native-start-service.ts';
import type { RunRuntimeSettings } from './run-service.ts';
import { withNativeMutation } from './native-mutation-boundary.ts';
import { commitNegativeOutcome } from './invocation-outcome-writer.ts';

// ==========================================================================
// SECTION 1/3 — S7-A · Parseur strict de sortie modèle
// ==========================================================================

/**
 * Ce que cette section est, exactement :
 *
 * ```text
 * texte brut NON FIABLE   →   résultat analysé DÉTERMINISTE
 * ```
 *
 * Fonction **pure**. Aucun disque, aucun réseau, aucun fournisseur, aucun
 * adaptateur, aucune horloge, aucun aléa, aucun run, aucun snapshot, aucun
 * ledger, aucun tri dépendant de la locale. Le même texte rend toujours le même
 * résultat, ou le même refus.
 *
 * ## La frontière que ce fichier ne franchit pas
 *
 * ```text
 * FORME VALIDE          ≠   L'OBJET EXISTE
 * CITATION BIEN FORMÉE  ≠   LA CITATION EXISTE DANS LE MATÉRIAU
 * SORTIE ANALYSABLE     ≠   FAIT CANONIQUE
 * ```
 *
 * Un identifiant canoniquement écrit mais désignant un objet inexistant
 * **traverse** ce parseur. Ce n'est pas une faiblesse : la matrice §17.2 du
 * contrat attribue l'existence, la liaison à l'ensemble soumis et la résolution
 * de citation à la phase C de S7-B, contre le snapshot courant. Les avancer ici
 * exigerait de lire un run, ce qui détruirait la pureté et déplacerait un refus
 * `REVALIDATION_REFUSED` vers `INVALID_OUTPUT` — deux faits différents.
 *
 * ## Aucune autorité canonique n'est créée ici
 *
 * Une proposition n'est **pas** une adduction. Ce module ne produit ni
 * `entry_id`, ni `recorded_at`, ni `recorded_by`, ni `semantic_origin`, ni
 * `derivation`, ni `invocation_id`, ni version de journal. Ces champs
 * appartiennent au service gouverné, après dispatch et revalidation.
 */

// --------------------------------------------------------------------------
// Version et borne
// --------------------------------------------------------------------------

/**
 * Version du protocole de sortie du modèle.
 *
 * **Distincte** de `EVIDENCE_SCHEMA_VERSION` (journal V4), des versions du
 * ledger d'invocation, de `CONTROVERSY_SCHEMA_VERSION` et de
 * `CONTROVERSY_DETECTOR_OUTPUT_VERSION` : autant de domaines, autant de
 * compteurs. Les confondre ferait dépendre un format de sortie d'un contrat de
 * persistance que le fournisseur n'a jamais signé.
 */
export const ADDUCTION_PROPOSAL_VERSION = 1;

/** Versions que ce parseur sait lire. Une valeur hors liste est un refus. */
export const SUPPORTED_ADDUCTION_PROPOSAL_VERSIONS: readonly number[] = [
  ADDUCTION_PROPOSAL_VERSION,
];

/**
 * Plafond de la sortie brute, en **octets UTF-8**.
 *
 * Le contrat (§19) fixe 1 Mio. La métrique est l'octet, jamais le point de code
 * ni l'unité UTF-16 : compter des caractères laisserait passer un document
 * quatre fois plus lourd que la borne dès qu'il est écrit hors ASCII.
 *
 * La mesure s'applique **avant** `JSON.parse` : refuser après analyse
 * reviendrait à avoir déjà construit la structure complète en mémoire, ce que la
 * borne existe précisément pour empêcher.
 *
 * Refus, **jamais** troncature — une sortie tronquée serait analysée comme si
 * elle était entière, et un lot amputé passerait pour un lot complet.
 */
export const MAX_ADDUCER_OUTPUT_BYTES = 1024 * 1024;

// --------------------------------------------------------------------------
// Formes
// --------------------------------------------------------------------------

/**
 * Citation **proposée** — forme seulement.
 *
 * Mêmes deux champs que `AdductionCitation` du domaine, et rien de plus : aucun
 * décalage d'octet, aucune plage DOM, aucune correspondance de ligne. Ce que ce
 * module établit tient en une phrase : `CITATION SHAPE VALID`. Que le texte cité
 * apparaisse réellement au rang demandé est le contrôle `V10`, qui exige le
 * matériau et appartient à la phase C.
 */
export interface ProposedAdductionCitation {
  readonly quoted_text: string;
  readonly occurrence: number;
}

/**
 * Une adduction **proposée**, et rien de plus.
 *
 * La forme de fil est **plate** : le contrat (§19) écrit `target_entry_id`, là
 * où le domaine porte `target: { kind, entry_id }`. La sorte de cible n'est pas
 * sur le fil, et ce n'est pas un oubli — `V5` (« la sorte de cible est admise »)
 * se décide sur la cible **résolue** dans le journal V3, donc en phase C. La
 * laisser proposer par le modèle reviendrait à lui faire déclarer la nature d'un
 * objet qu'il ne fait que désigner.
 *
 * Elle ne porte ni `entry_id`, ni `schema_version`, ni `recorded_at`, ni
 * `recorded_by`, ni `semantic_origin`, ni `derivation`, ni `invocation_id`, ni
 * `provider`, ni `model`, ni `usage`, ni coût : le schéma les **refuse** au lieu
 * de les ignorer.
 */
export interface ProposedAdduction {
  readonly material_id: string;
  readonly target_entry_id: string;
  readonly orientation: Orientation;
  readonly citation?: ProposedAdductionCitation;
}

/**
 * Motifs de refus — fermés, publics, stables.
 *
 * Les cinq premiers reprennent, à l'identique, le vocabulaire déjà gelé du
 * parseur V3 : même frontière, mêmes mots. Le sixième est propre à V4 et n'a pas
 * d'équivalent V3, parce que le contrôle qu'il nomme n'existait pas — V3
 * n'imposait aucun refus des doublons dans une même sortie, `V11` l'impose.
 *
 * Il est nommé séparément plutôt que replié sur `INVALID_PROPOSAL` : une
 * proposition en double n'est pas malformée, c'est le **lot** qui l'est
 * (contrat §20.2). Confondre les deux ferait mentir le motif, que le contrat
 * (§17.5) exige précisément d'exposer.
 */
export const ADDUCER_OUTPUT_REFUSAL_REASONS = [
  'OUTPUT_TOO_LARGE',
  'INVALID_JSON',
  'UNSUPPORTED_OUTPUT_VERSION',
  'INVALID_OUTPUT_SHAPE',
  'INVALID_PROPOSAL',
  'DUPLICATE_PROPOSAL',
] as const;
export type AdducerOutputRefusalReason = (typeof ADDUCER_OUTPUT_REFUSAL_REASONS)[number];

/**
 * Issue de l'analyse — union **discriminée**.
 *
 * ```text
 * VALID  · proposals: []      →  VALID_ZERO, un SUCCÈS de protocole
 * INVALID                     →  un ÉCHEC, motif et position exigés
 * ```
 *
 * La forme interdit **structurellement** qu'un refus s'effondre en liste vide :
 * un appelant qui lirait `proposals` sans lire `outcome` ne compilerait pas.
 * C'est la seule protection qui ne dépend pas de la vigilance de l'appelant.
 *
 * `VALID_ZERO` ne dit **rien** du monde : ni qu'aucune preuve n'existe, ni
 * qu'aucune relation n'existe, ni que les experts s'accordent, ni que le
 * fournisseur a échoué, ni que le modèle est incapable, ni que la cible est
 * vraie ou fausse. Il dit qu'une réponse bien formée ne proposait rien.
 *
 * Aucun `PROVIDER_FAILED` n'est déductible ici : ce module ne sait rien du
 * transport. Recevoir un texte suppose déjà qu'une réponse existe.
 */
export type AdductionProposalParse =
  | {
      readonly outcome: 'VALID';
      readonly adduction_proposal_version: number;
      /** Ordre de production préservé — jamais retrié, jamais dédupliqué. */
      readonly proposals: readonly ProposedAdduction[];
    }
  | {
      readonly outcome: 'INVALID';
      readonly reason: AdducerOutputRefusalReason;
      /** Chemin de validation stable, sans pile ni interne volatile. */
      readonly at: string;
    };

function invalid(reason: AdducerOutputRefusalReason, at: string): AdductionProposalParse {
  return { outcome: 'INVALID', reason, at };
}

// --------------------------------------------------------------------------
// Analyse
// --------------------------------------------------------------------------

const OUTPUT_KEYS: readonly string[] = ['adduction_proposal_version', 'proposals'];
const PROPOSAL_KEYS: readonly string[] = [
  'material_id',
  'target_entry_id',
  'orientation',
  'citation',
];
const CITATION_KEYS: readonly string[] = ['quoted_text', 'occurrence'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Refuse tout champ étranger, à **tout** niveau fermé.
 *
 * Un champ inconnu est refusé, jamais ignoré. Le contrat (§19) en donne le
 * motif : ignorer en silence un champ de score affaiblirait le schéma fermé et
 * laisserait croire qu'il a été pris en compte, ou qu'il pourrait l'être.
 *
 * Sont donc refusés — parce qu'ils sont **hors schéma**, sans qu'aucune liste
 * noire n'ait à les nommer :
 *
 * ```text
 * confidence · score · reliability · credibility · weight · strength
 * sufficiency · truth · probability · winner · closure · quality
 * provider · model · cost · tokens · usage
 * entry_id · recorded_at · recorded_by · semantic_origin · derivation
 * invocation_id · schema_version · evidence_revision
 * ```
 *
 * Deux familles, un seul mécanisme. Les premiers sont des jugements que CCR
 * n'émet pas ; les seconds sont des autorités que le serveur attribue et qu'un
 * fournisseur ne doit jamais pouvoir forger. La forme `const { known } = payload`
 * — extraire le connu et laisser tomber le reste — leur ouvrirait la porte aux
 * uns comme aux autres.
 */
function hasOnly(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

/**
 * Citation : forme seulement, bornes du domaine.
 *
 * Les deux champs sont **exigés ensemble**. Une citation incomplète est un refus
 * et non une citation partielle : `quoted_text` sans rang ne désigne rien de
 * décidable, et un rang sans texte ne désigne rien du tout.
 *
 * La borne de `quoted_text` est celle du domaine (`MAX_INLINE_TEXT_BYTES`),
 * importée et non redéclarée : une citation ne peut pas être plus longue que le
 * texte le plus long que CCR accepte de détenir.
 */
function parseCitation(value: unknown, at: string): ProposedAdductionCitation | AdductionProposalParse {
  if (!isPlainObject(value)) return invalid('INVALID_PROPOSAL', at);
  if (!hasOnly(value, CITATION_KEYS)) return invalid('INVALID_PROPOSAL', `${at}.<champ inconnu>`);

  const quoted = value['quoted_text'];
  if (typeof quoted !== 'string' || quoted.length === 0) {
    return invalid('INVALID_PROPOSAL', `${at}.quoted_text`);
  }
  if (utf8ByteLength(quoted) > MAX_INLINE_TEXT_BYTES) {
    return invalid('INVALID_PROPOSAL', `${at}.quoted_text`);
  }

  // Rang 1-based, entier sûr. Convention du domaine, reprise sans altération :
  // ni 0, ni négatif, ni fractionnaire, ni décalage d'octet déguisé en rang.
  const occurrence = value['occurrence'];
  if (typeof occurrence !== 'number' || !Number.isSafeInteger(occurrence) || occurrence < 1) {
    return invalid('INVALID_PROPOSAL', `${at}.occurrence`);
  }

  return { quoted_text: quoted, occurrence };
}

function parseProposal(value: unknown, at: string): ProposedAdduction | AdductionProposalParse {
  if (!isPlainObject(value)) return invalid('INVALID_PROPOSAL', at);
  if (!hasOnly(value, PROPOSAL_KEYS)) return invalid('INVALID_PROPOSAL', `${at}.<champ inconnu>`);

  // `V1` — forme canonique du matériau. La primitive S1 fait autorité et exige
  // l'aller-retour `format(parse(id)) === id` : aucune expression régulière
  // n'est recopiée ici, et `mat_0000001` ne passe pas pour canonique.
  const materialId = value['material_id'];
  if (!isMaterialId(materialId)) return invalid('INVALID_PROPOSAL', `${at}.material_id`);

  // `V3` — forme canonique de la cible. Une cible est une ENTRÉE : `ctv_`
  // désigne une controverse, jamais une cible, et la primitive S1 le refuse.
  const targetEntryId = value['target_entry_id'];
  if (!isControversyEntryTargetId(targetEntryId)) {
    return invalid('INVALID_PROPOSAL', `${at}.target_entry_id`);
  }

  // `V8` — orientation dans l'union fermée du domaine, importée et jamais
  // redéclarée. Aucune valeur voisine n'est acceptée ni traduite : ni NEUTRAL,
  // ni SUPPORT, ni OBJECT, ni AGAINST, ni TRUE, ni FALSE. Une orientation
  // absente est refusée, jamais ramenée à NONE — un silence du modèle deviendrait
  // sinon une position neutre que personne n'a prise.
  const orientation = value['orientation'];
  if (typeof orientation !== 'string' || !(ORIENTATIONS as readonly string[]).includes(orientation)) {
    return invalid('INVALID_PROPOSAL', `${at}.orientation`);
  }

  // Facultative : absente du payload, elle reste absente. `null` n'est pas
  // « absent » — c'est une valeur, et elle n'est pas une citation.
  if (!('citation' in value)) {
    return {
      material_id: materialId as string,
      target_entry_id: targetEntryId as string,
      orientation: orientation as Orientation,
    };
  }

  const citation = parseCitation(value['citation'], `${at}.citation`);
  if ('outcome' in citation) return citation;

  return {
    material_id: materialId as string,
    target_entry_id: targetEntryId as string,
    orientation: orientation as Orientation,
    citation,
  };
}

/**
 * Clé d'identité **exacte** d'une proposition, pour `V11`.
 *
 * Comparaison octet à octet des quatre faits proposés, citation comprise.
 * Aucune normalisation : ni casse, ni espaces, ni forme Unicode, ni URL, ni
 * similarité sémantique, ni correspondance approchée. Le contrat (§20.1) est
 * explicite — CCR ne possède aucune autorité d'équivalence, et deux propositions
 * qui ne diffèrent que par leur citation sont deux propositions distinctes.
 *
 * `JSON.stringify` sur un tuple fixe donne une clé injective : l'échappement des
 * chaînes est déterministe, et aucun séparateur choisi à la main ne peut être
 * confondu avec du contenu.
 */
function proposalIdentity(proposal: ProposedAdduction): string {
  return JSON.stringify([
    proposal.material_id,
    proposal.target_entry_id,
    proposal.orientation,
    proposal.citation === undefined
      ? null
      : [proposal.citation.quoted_text, proposal.citation.occurrence],
  ]);
}

/**
 * Analyse une sortie de modèle non fiable.
 *
 * ```text
 * 1  borne brute, AVANT JSON.parse
 * 2  syntaxe JSON stricte
 * 3  enveloppe versionnée et fermée
 * 4  chaque proposition — V1 · V3 · V8
 * 5  aucun doublon dans le lot — V11
 * ```
 *
 * **Aucune réparation.** Pas d'extraction du « JSON probable » d'un texte libre,
 * pas de retrait de clôtures Markdown, pas de complétion d'un champ manquant, pas
 * de nettoyage, pas de devinette, et aucun second appel au modèle. Le protocole
 * est la charge du fournisseur ; le tolérer à moitié le rendrait facultatif.
 *
 * **Tout ou rien.** Une seule proposition invalide parmi `N` rend le lot entier
 * `INVALID`. Rendre `N-1` propositions valides et en taire une reviendrait à
 * livrer une sortie mutilée en la présentant comme une sortie complète.
 */
export function parseAdductionProposals(raw: string): AdductionProposalParse {
  // 1 — la borne, AVANT toute analyse. Un payload hors borne n'atteint jamais
  //     `JSON.parse` : c'est la garde, pas un contrôle de courtoisie.
  if (typeof raw !== 'string') return invalid('INVALID_OUTPUT_SHAPE', 'output');
  if (utf8ByteLength(raw) > MAX_ADDUCER_OUTPUT_BYTES) return invalid('OUTPUT_TOO_LARGE', 'output');

  // 2 — syntaxe. Le texte doit être un document JSON entier : rien avant, rien
  //     après, aucune clôture ```json, aucun commentaire.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalid('INVALID_JSON', 'output');
  }

  // 3 — enveloppe versionnée, fermée.
  if (!isPlainObject(parsed)) return invalid('INVALID_OUTPUT_SHAPE', 'output');
  if (!hasOnly(parsed, OUTPUT_KEYS)) return invalid('INVALID_OUTPUT_SHAPE', 'output.<champ inconnu>');

  const version = parsed['adduction_proposal_version'];
  if (typeof version !== 'number' || !SUPPORTED_ADDUCTION_PROPOSAL_VERSIONS.includes(version)) {
    // Version absente ou inconnue : refus, jamais une analyse « au mieux ».
    return invalid('UNSUPPORTED_OUTPUT_VERSION', 'output.adduction_proposal_version');
  }

  const proposals = parsed['proposals'];
  if (!Array.isArray(proposals)) return invalid('INVALID_OUTPUT_SHAPE', 'output.proposals');

  // 4 — forme du domaine, proposition par proposition. Le premier refus arrête
  //     l'analyse : une sortie partiellement lisible n'est pas une sortie valide
  //     amputée, c'est une sortie qu'on ne sait pas lire.
  const validated: ProposedAdduction[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < proposals.length; index += 1) {
    const outcome = parseProposal(proposals[index], `output.proposals[${String(index)}]`);
    if ('outcome' in outcome) return outcome;

    // 5 — `V11`. Le doublon invalide le LOT, il n'en est pas retiré en silence :
    //     supprimer la seconde occurrence rendrait un lot que le modèle n'a pas
    //     produit, et masquerait la seule information utile — sa réponse est mal
    //     formée.
    const identity = proposalIdentity(outcome);
    if (seen.has(identity)) {
      return invalid('DUPLICATE_PROPOSAL', `output.proposals[${String(index)}]`);
    }
    seen.add(identity);

    validated.push(outcome);
  }

  return {
    outcome: 'VALID',
    adduction_proposal_version: version,
    // Ordre de production préservé : le parseur ne crée aucune autorité d'ordre,
    // et ne détruit pas non plus celle de la sortie.
    proposals: validated,
  };
}
// ==========================================================================
// SECTION 2/3 — S7-B · Dispatch gouverné, en trois phases
// ==========================================================================

/**
 * Le chemin `MODEL_ASSISTED` complet, et rien de plus.
 *
 * ```text
 * PHASE A   verrou de run COURT
 *           faits canoniques stables → périmètre → ensemble soumis
 *           → quota → invocation_id → DISPATCH_COMMITTED durable
 *           → LIBÉRATION DU VERROU
 *
 * PHASE B   HORS verrou — un seul appel d'adaptateur, jamais deux
 *
 * ANALYSE   section 1/3, sans verrou, sans autorité canonique
 *
 * PHASE C   verrou de run COURT
 *           relecture canonique → matrice §17.2 → persistance du lot
 * ```
 *
 * ## Ce que cette section n'est pas
 *
 * Elle n'est pas une **disponibilité**. Aucune commande, aucune route, aucun
 * bouton ne la nomme ; aucun tour, aucune lecture, aucune mutation humaine et
 * aucun rafraîchissement ne la déclenchent. La porte publique et la voie
 * d'acceptation contrôlée appartiennent à la section 3/3, qui n'existe pas
 * encore.
 *
 * ## Pourquoi deux fenêtres de verrou, et non une
 *
 * Le verrou de run n'est pas réentrant : les phases A et C sont deux
 * acquisitions successives, jamais imbriquées, et l'appel fournisseur tient
 * exactement **entre** les deux. C'est ce qui empêche la latence d'un modèle de
 * bloquer les mutations du run — propriété établie dynamiquement, par une
 * mutation concurrente réussie pendant l'appel, jamais par lecture de source.
 *
 * ## Ce que la phase C ne réutilise jamais
 *
 * Les faits du moment du dispatch. Elle relit un snapshot stable. De la phase A
 * elle ne conserve qu'**une** chose : l'ensemble réellement soumis au modèle.
 *
 * ```text
 * EXISTE MAINTENANT   ≠   A ÉTÉ SOUMIS AU MODÈLE
 * ```
 *
 * Cet ensemble ne décrit pas l'état du run ; il décrit ce que le modèle a vu.
 * Rien ne peut l'enrichir après coup, et une entrée apparue pendant l'appel ne
 * devient jamais rétroactivement une entrée soumise.
 */

// --------------------------------------------------------------------------
// Dépendances, demande, issues
// --------------------------------------------------------------------------

/** Fabrique d'adaptateurs, réduite à ce que l'adduction assistée en utilise. */
export interface AdductionAdapters {
  readonly claude: AgentAdapter;
  readonly codex: AgentAdapter;
}

export interface ModelAdductionDeps {
  readonly runsDir: string;
  now(): Date;
  createAdapters(cwd: string, runtime?: RunRuntimeSettings): AdductionAdapters;
}

/**
 * Le geste humain, tel qu'il est nommé — le plus petit périmètre du contrat.
 *
 * ```text
 * UN matériau détenu   et   UNE controverse, par son entrée d'ouverture
 * ```
 *
 * L'appelant ne choisit **jamais** le fournisseur, le modèle, l'`invocation_id`,
 * l'origine sémantique, l'enregistreur, l'horodatage ni la dérivation.
 * `expert_slot` désigne le moteur qui exécutera ; CCR en dérive le fournisseur
 * depuis le manifest, plutôt que de le recevoir.
 *
 * La controverse est nommée par son **entrée d'ouverture**, jamais par `ctv_` :
 * V4 ne manipule pas d'identité d'agrégat, et en accepter une ici ouvrirait par
 * la porte de service la sorte de cible que le contrat a refusé de créer.
 */
export interface ModelAdductionRequest {
  readonly runId: string;
  readonly material_id: string;
  readonly controversy_opening_entry_id: string;
  readonly expert_slot: ExpertSlotId;
}

/**
 * Motifs de refus **avant tout engagement**.
 *
 * Un refus de périmètre ne coûte rien : zéro quota consommé, zéro
 * `invocation_id`, zéro ligne de ledger, zéro adaptateur construit. Il n'est
 * donc **pas** une des quatre issues du contrat §17.5, qui décrivent les
 * retours contrôlés lorsqu'un appel a eu lieu.
 */
export const MODEL_ADDUCTION_SCOPE_REFUSAL_REASONS = [
  'MATERIAL_NOT_FOUND',
  'MATERIAL_NOT_HELD',
  'MATERIAL_CONTENT_UNAVAILABLE',
  'CONTROVERSY_NOT_FOUND',
  'EVIDENCE_NOT_AVAILABLE',
] as const;
export type ModelAdductionScopeRefusalReason =
  (typeof MODEL_ADDUCTION_SCOPE_REFUSAL_REASONS)[number];

function refuseScope(
  reason: ModelAdductionScopeRefusalReason,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): CcrError {
  return new CcrError('INVALID_ARGUMENT', message, { details: { reason, ...details } });
}

/**
 * Les sept contrôles de phase C, **nommés par le contrat** §17.2.
 *
 * Les quatre autres — `V1`, `V3`, `V8`, `V11` — appartiennent au parseur de la
 * section 1/3 et produisent `INVALID_OUTPUT`. Aucun n'est déplacé, dans aucun
 * sens : un contrôle de forme avancé en phase C arriverait trop tard, et un
 * contrôle d'existence avancé au parseur exigerait de lire un run.
 */
export const REVALIDATION_CHECKS = ['V2', 'V4', 'V5', 'V6', 'V7', 'V9', 'V10'] as const;
export type RevalidationCheck = (typeof REVALIDATION_CHECKS)[number];

/**
 * Issue d'une demande d'adduction assistée — union discriminée, fermée.
 *
 * Les cinq branches sont des faits opérationnels distincts, et le type interdit
 * de les confondre. Aucune valeur `PARTIALLY_VALIDATED`, `PARTIAL_SUCCESS`,
 * `RETRYING`, `RECOVERING` n'existe — et `UNKNOWN_AFTER_COMMITMENT` **n'est pas
 * une issue rendue** : c'est ce qui reste lisible quand aucun retour n'existe.
 *
 * Dans les cinq cas, l'invocation reste enregistrée au ledger. Un engagement
 * durable ne s'efface pas parce que la suite a échoué.
 */
export type ModelAdductionOutcome =
  | {
      readonly kind: 'PERSISTED';
      readonly invocation_id: string;
      readonly entries: readonly AdductionRecordedEntry[];
      readonly evidence_revision: string;
    }
  | { readonly kind: 'VALID_ZERO'; readonly invocation_id: string }
  | {
      readonly kind: 'INVALID_OUTPUT';
      readonly invocation_id: string;
      readonly reason: AdducerOutputRefusalReason;
      readonly at: string;
    }
  | {
      readonly kind: 'REVALIDATION_REFUSED';
      readonly invocation_id: string;
      /** Contrôle en cause — exigé par le contrat §17.5. */
      readonly check: RevalidationCheck;
      readonly at: string;
      readonly detail: string;
    }
  | {
      readonly kind: 'PROVIDER_FAILED';
      readonly invocation_id: string;
      readonly error_code: string;
    };

/** Coutures de test. Aucune production n'en fournit. */
export interface ModelAdductionSeams {
  /** Appelée quand le verrou de phase A est relâché, avant l'adaptateur. */
  readonly beforeProvider?: () => void | Promise<void>;
  readonly openInvocationLedger?: typeof openInvocationLedger;
  readonly openUsageLedger?: typeof openUsageLedger;
}

/**
 * L'ensemble **réellement soumis** au modèle, calculé par le serveur.
 *
 * ```text
 * AUTORITÉ DE LIAISON   =   AUTORITÉ DES ENTRÉES DE DÉRIVATION
 * ```
 *
 * Ce n'est pas une formule : `V6`/`V7` et `derivation.inputs` lisent le **même**
 * objet, produit une seule fois en phase A. Les laisser diverger permettrait de
 * persister une dérivation affirmant des entrées que le modèle n'a jamais vues.
 */
export interface SubmittedDispatchInputs {
  readonly materials: readonly string[];
  readonly targets: readonly string[];
}

/** Ce que la phase A établit, et que les phases suivantes consomment. */
interface AdductionDispatchPlan {
  readonly invocationId: string;
  readonly provider: ProviderKind;
  readonly cwd: string;
  readonly runtime: RunRuntimeSettings | undefined;
  readonly prompt: string;
  readonly submitted: SubmittedDispatchInputs;
}

/** Les entrées de dérivation, dérivées de l'ensemble soumis — jamais d'ailleurs. */
export function derivationInputsOf(submitted: SubmittedDispatchInputs): readonly string[] {
  return [...submitted.materials, ...submitted.targets];
}

// --------------------------------------------------------------------------
// Demande adressée au modèle
// --------------------------------------------------------------------------

/**
 * Construit la demande.
 *
 * Elle décrit **exactement** le protocole que la section 1/3 accepte : demander
 * un champ que le parseur refuserait ensuite serait inviter une sortie invalide.
 *
 * Ce qui n'est jamais demandé : une confiance, un score, une fiabilité, une
 * suffisance, une vérité, un gagnant, une clôture, un fournisseur, un modèle, un
 * coût, une origine sémantique, une dérivation, une invocation, un identifiant
 * d'adduction. Le modèle **propose des rattachements** entre un matériau
 * enregistré et des entrées existantes ; il ne juge pas le fond.
 */
export function buildAdductionPrompt(
  materialId: string,
  materialContent: string,
  entries: readonly ControversyEntry[],
): string {
  const lines = entries.map((entry) => {
    const text = entry.anchors.semantic?.text ?? entry.content ?? '';
    return `- ${entry.entry_id} · ${entry.kind} · ${text}`;
  });

  return [
    'Tu examines UN matériau enregistré et les entrées d’une controverse CCR.',
    '',
    `Matériau : ${materialId}`,
    '--- début du matériau ---',
    materialContent,
    '--- fin du matériau ---',
    '',
    'Entrées de la controverse :',
    ...lines,
    '',
    'Propose zéro ou plusieurs ADDUCTIONS : verser ce matériau au débat à propos',
    'de l’une de ces entrées, avec une orientation argumentative. Une adduction',
    'n’affirme pas que le matériau est vrai, fiable ou suffisant, ni que la cible',
    'est vraie ou fausse, ni qu’un expert a raison.',
    '',
    `Orientations admises, et elles seules : ${ORIENTATIONS.join(', ')}.`,
    'Tu ne peux nommer que le matériau ci-dessus et les entrées ci-dessus.',
    '',
    'Réponds UNIQUEMENT par un objet JSON de cette forme, sans texte autour :',
    '{',
    `  "adduction_proposal_version": ${String(ADDUCTION_PROPOSAL_VERSION)},`,
    '  "proposals": [',
    '    {',
    `      "material_id": "${materialId}",`,
    '      "target_entry_id": "<identifiant d’entrée ci-dessus>",',
    '      "orientation": "<orientation admise>",',
    '      "citation": { "quoted_text": "<extrait exact du matériau>", "occurrence": 1 }',
    '    }',
    '  ]',
    '}',
    '',
    'Le champ « citation » est facultatif. Présent, l’extrait doit apparaître',
    'EXACTEMENT dans le matériau ci-dessus, au rang indiqué.',
    '',
    'Aucun autre champ n’est accepté : ni confiance, ni score, ni fiabilité, ni',
    'suffisance, ni vérité, ni gagnant, ni fournisseur, ni modèle, ni coût, ni',
    'identifiant que tu aurais choisi.',
    'Si tu ne proposes aucune adduction, rends une liste vide — c’est une réponse',
    'valide.',
  ].join('\n');
}

// --------------------------------------------------------------------------
// PHASE A — sous verrou court
// --------------------------------------------------------------------------

/** Contenu détenu d'un matériau, tel qu'il sera réellement soumis. */
function heldContentOf(
  snapshot: NativeRunSnapshot,
  material: MaterialRecordedEntry,
): string {
  const representation = material.representation;

  // `EXTERNAL_REFERENCE` est refusé ICI, avant tout engagement : CCR ne détient
  // aucun contenu à soumettre, et envoyer un localisateur seul reviendrait à
  // demander au modèle de raisonner sur une chose qu'il n'a pas vue.
  if (!materialIsHeld(representation.form)) {
    throw refuseScope(
      'MATERIAL_NOT_HELD',
      `Le matériau ${material.entry_id} est de forme ${representation.form} : CCR n'en détient ` +
        "aucune représentation à soumettre. Une adduction HUMAINE reste possible ; une demande " +
        'assistée par modèle ne l’est pas.',
      { material_id: material.entry_id, form: representation.form },
    );
  }

  // Discriminant testé POSITIVEMENT sur les deux formes détenues : la garde
  // `materialIsHeld` rend un booléen, qui ne rétrécit pas l'union.
  if (representation.form === 'INLINE_TEXT') return representation.text;

  if (representation.form === 'RUN_EVENT') {
    const event = snapshot.events.find((c) => c.event_id === representation.event_id);
    if (event === undefined || typeof event.content !== 'string') {
      throw refuseScope(
        'MATERIAL_CONTENT_UNAVAILABLE',
        `Le contenu du matériau ${material.entry_id} n'est pas disponible : rien ne peut être soumis.`,
        { material_id: material.entry_id, event_id: representation.event_id },
      );
    }
    return event.content;
  }

  // Inatteignable : la garde ci-dessus a déjà refusé cette forme. Le même refus
  // est rendu, pour qu'aucun monde — même impossible — ne diffère.
  throw refuseScope(
    'MATERIAL_NOT_HELD',
    `Le matériau ${material.entry_id} est de forme ${representation.form} : CCR n'en détient ` +
      "aucune représentation à soumettre. Une adduction HUMAINE reste possible ; une demande " +
      'assistée par modèle ne l’est pas.',
    { material_id: material.entry_id, form: representation.form },
  );
}

async function planAdduction(
  deps: ModelAdductionDeps,
  request: ModelAdductionRequest,
  seams: ModelAdductionSeams,
): Promise<AdductionDispatchPlan> {
  const paths = runPaths(deps.runsDir, request.runId);

  return withNativeMutation(
    { runsDir: deps.runsDir, runId: request.runId, command: 'v4-adduce-model-dispatch' },
    async () => {
      const snapshot = await readStableNativeRunSnapshot(deps.runsDir, request.runId);

      // ---- Le matériau nommé. Canonique, enregistré dans CE run, et détenu.
      if (!isMaterialId(request.material_id)) {
        throw refuseScope(
          'MATERIAL_NOT_FOUND',
          `material_id non canonique : ${String(request.material_id)}.`,
          { material_id: request.material_id },
        );
      }
      let material: MaterialRecordedEntry | undefined;
      for (const entry of snapshot.evidence) {
        if (entry.kind === 'MATERIAL_RECORDED' && entry.entry_id === request.material_id) {
          material = entry;
        }
      }
      if (material === undefined) {
        throw refuseScope(
          'MATERIAL_NOT_FOUND',
          `Le matériau ${request.material_id} n'est pas enregistré dans ce run.`,
          { material_id: request.material_id },
        );
      }
      const content = heldContentOf(snapshot, material);

      // ---- La controverse nommée, par son entrée d'ouverture. Le périmètre est
      // une controverse de CE run, et elle seule : aucune portée inter-run,
      // aucune chronologie totale, aucun autre matériau.
      if (!isControversyEntryTargetId(request.controversy_opening_entry_id)) {
        throw refuseScope(
          'CONTROVERSY_NOT_FOUND',
          `Entrée d'ouverture non canonique : ${String(request.controversy_opening_entry_id)}.`,
          { opening_entry_id: request.controversy_opening_entry_id },
        );
      }
      const projection = projectControversyReadModel(snapshot);
      if (projection.availability !== 'AVAILABLE') {
        throw refuseScope(
          'CONTROVERSY_NOT_FOUND',
          `Le run ${request.runId} ne porte pas de journal V3.`,
          { runId: request.runId },
        );
      }
      const item = projection.items.find(
        (candidate) => candidate.opening?.entry_id === request.controversy_opening_entry_id,
      );
      if (item === undefined) {
        throw refuseScope(
          'CONTROVERSY_NOT_FOUND',
          `Aucune controverse de ce run ne s'ouvre par ${request.controversy_opening_entry_id}.`,
          { opening_entry_id: request.controversy_opening_entry_id },
        );
      }

      // ---- L'ensemble soumis, calculé par le SERVEUR. Le fournisseur ne
      // choisira jamais un matériau ni une cible hors de cet ensemble.
      const submitted: SubmittedDispatchInputs = {
        materials: [material.entry_id],
        targets: item.entries.map((entry) => entry.entry_id),
      };
      const prompt = buildAdductionPrompt(material.entry_id, content, item.entries);

      const binding = snapshot.manifest.experts[request.expert_slot];

      // ---- Quota AVANT engagement. Un refus ne crée aucune invocation et
      // n'atteint jamais un adaptateur.
      await assertInvocationQuotaAvailable(paths, request.runId);

      // ---- Engagement durable. Version 3 du ledger, choisie par S6 d'après la
      // charge — jamais par ce module, qui ne connaît que le déclencheur.
      const invocations = await (seams.openInvocationLedger ?? openInvocationLedger)(
        paths,
        request.runId,
      );
      const dispatch = await invocations.append(
        {
          identity: {
            generation: 'NATIVE_V21_EXECUTION',
            expert_slot: request.expert_slot,
            provider: binding.provider,
          },
          trigger_kind: EVIDENCE_ADDUCTION_TRIGGER,
        },
        deps.now(),
      );

      return {
        invocationId: dispatch.invocation_id,
        provider: binding.provider,
        cwd: snapshot.manifest.workspace.cwd,
        runtime:
          snapshot.manifest.runtime_config === undefined
            ? undefined
            : runtimeSettingsOf(snapshot.manifest.runtime_config),
        prompt,
        submitted,
      };
    },
  );
}

// --------------------------------------------------------------------------
// PHASE C — revalidation déterministe
// --------------------------------------------------------------------------

/**
 * Occurrences exactes, **chevauchements compris**, rang 1-based.
 *
 * Réénoncée ici plutôt que partagée, exactement pour la raison que S4 a déjà
 * écrite : la mutualiser exigerait de modifier un module d'une tranche acceptée.
 * Le coût est douze lignes ; le prix de l'alternative serait de rouvrir S1, S3
 * ou S4. Un test croisé vérifie que les trois formulations s'accordent.
 */
function occurrenceExists(content: string, quoted: string, occurrence: number): boolean {
  let found = 0;
  let from = 0;
  for (;;) {
    const index = content.indexOf(quoted, from);
    if (index === -1) return false;
    found += 1;
    if (found === occurrence) return true;
    from = index + 1;
  }
}

/** Faits canoniques **courants**, relus en phase C. Jamais ceux du dispatch. */
export interface RevalidationContext {
  readonly materialsById: ReadonlyMap<string, MaterialRecordedEntry>;
  readonly controversyEntriesById: ReadonlyMap<string, ControversyEntry>;
  readonly events: ReadonlyMap<string, NativeCcrEvent>;
}

export function revalidationContextOf(snapshot: NativeRunSnapshot): RevalidationContext {
  const materialsById = new Map<string, MaterialRecordedEntry>();
  for (const entry of snapshot.evidence) {
    if (entry.kind === 'MATERIAL_RECORDED') materialsById.set(entry.entry_id, entry);
  }
  const controversyEntriesById = new Map<string, ControversyEntry>();
  for (const entry of snapshot.controversies) controversyEntriesById.set(entry.entry_id, entry);
  const events = new Map<string, NativeCcrEvent>();
  for (const event of snapshot.events) events.set(event.event_id, event);
  return { materialsById, controversyEntriesById, events };
}

export interface RevalidationRefusal {
  readonly check: RevalidationCheck;
  readonly at: string;
  readonly detail: string;
}

function refused(check: RevalidationCheck, at: string, detail: string): RevalidationRefusal {
  return { check, at, detail };
}

/**
 * La matrice §17.2, pour **une** proposition — fonction pure et déterministe.
 *
 * L'ordre est normatif, et il n'est pas cosmétique :
 *
 * ```text
 * V6   le matériau appartenait à l'ensemble soumis      ← AVANT V2
 * V7   la cible appartenait à l'ensemble soumis         ← AVANT V4
 * V2   le matériau résout dans le journal V4 du run
 * V4   la cible résout dans le journal V3 du run
 * V5   la sorte de cible est admise
 * V9   si citation : le matériau est détenu
 * V10  si citation : le texte apparaît au rang annoncé
 * ```
 *
 * `V6`/`V7` précèdent parce qu'ils ne dépendent **pas** de l'état courant. Les
 * placer après laisserait passer une proposition hors périmètre au seul motif
 * qu'elle est par ailleurs canoniquement valide — précisément le défaut que la
 * réparation d'entrée de S7-B V3 avait révélé.
 *
 * Aucun de ces contrôles ne juge le fond. Un succès complet établit qu'une
 * proposition est **structurellement recevable** ; jamais qu'elle est
 * convaincante, que `SUPPORTS` est correct, que `OBJECTS_TO` est correct, que la
 * cible est vraie, que le matériau est fiable, ni que la preuve est suffisante.
 */
export function revalidateProposal(
  ctx: RevalidationContext,
  submitted: SubmittedDispatchInputs,
  proposal: ProposedAdduction,
  at: string,
): RevalidationRefusal | undefined {
  // ---- V6 — liaison du matériau à l'ensemble soumis.
  if (!submitted.materials.includes(proposal.material_id)) {
    return refused(
      'V6',
      `${at}.material_id`,
      `${proposal.material_id} n'a pas été soumis au modèle : exister dans le run ne suffit pas.`,
    );
  }

  // ---- V7 — liaison de la cible à l'ensemble soumis. Une entrée ajoutée
  // pendant l'appel existe peut-être ; elle n'a pas été vue.
  if (!submitted.targets.includes(proposal.target_entry_id)) {
    return refused(
      'V7',
      `${at}.target_entry_id`,
      `${proposal.target_entry_id} n'a pas été soumis au modèle : exister maintenant ne suffit pas.`,
    );
  }

  // ---- V2 — résolution canonique du matériau dans le journal V4 du run.
  const material = ctx.materialsById.get(proposal.material_id);
  if (material === undefined) {
    return refused('V2', `${at}.material_id`, `${proposal.material_id} ne résout pas dans ce run.`);
  }

  // ---- V4 — résolution canonique de la cible dans le journal V3 du run. Le
  // snapshot est propre au run : résoudre ici, c'est appartenir à ce run.
  const target = ctx.controversyEntriesById.get(proposal.target_entry_id);
  if (target === undefined) {
    return refused('V4', `${at}.target_entry_id`, `${proposal.target_entry_id} ne résout pas dans ce run.`);
  }

  // ---- V5 — sorte de cible admise. Une seule sorte V4 existe,
  // `CONTROVERSY_ENTRY`, et elle couvre les cinq sortes d'entrées V3 sans en
  // ajouter aucune. Une sixième sorte apparue en V3 serait refusée ici tant que
  // le contrat V4 ne l'aurait pas admise — c'est ce que ce contrôle protège.
  if (!(CONTROVERSY_ENTRY_KINDS as readonly string[]).includes(target.kind)) {
    return refused('V5', `${at}.target_entry_id`, `Sorte de cible non admise : ${String(target.kind)}.`);
  }

  if (proposal.citation === undefined) return undefined;

  // ---- V9 — une citation exige un matériau détenu : sans représentation, il
  // n'existe rien à confronter. Le refus porte sur la citation, jamais sur le
  // matériau.
  const representation = material.representation;
  if (!materialIsHeld(representation.form)) {
    return refused(
      'V9',
      `${at}.citation`,
      `Le matériau ${material.entry_id} est ${representation.form} : aucune confrontation n'est possible.`,
    );
  }
  // Discriminant testé POSITIVEMENT, même raison qu'en phase A.
  let content: string;
  if (representation.form === 'INLINE_TEXT') {
    content = representation.text;
  } else if (representation.form === 'RUN_EVENT') {
    const event = ctx.events.get(representation.event_id);
    if (event === undefined || typeof event.content !== 'string') {
      return refused(
        'V9',
        `${at}.citation`,
        `Le contenu du matériau ${material.entry_id} n'est pas disponible.`,
      );
    }
    content = event.content;
  } else {
    // Inatteignable : `materialIsHeld` a déjà rendu ce refus `V9`. Il est rendu
    // à l'identique plutôt qu'un chemin nouveau.
    return refused(
      'V9',
      `${at}.citation`,
      `Le matériau ${material.entry_id} est ${representation.form} : aucune confrontation n'est possible.`,
    );
  }

  // ---- V10 — le texte cité apparaît EXACTEMENT au rang annoncé. Ce contrôle
  // établit `CITATION EXISTS IN MATERIAL`, et jamais `CITATION SUPPORTS TARGET`.
  if (!occurrenceExists(content, proposal.citation.quoted_text, proposal.citation.occurrence)) {
    return refused(
      'V10',
      `${at}.citation`,
      `La citation ne se confronte pas au rang ${String(proposal.citation.occurrence)} du matériau ` +
        `${material.entry_id}.`,
    );
  }

  return undefined;
}

// --------------------------------------------------------------------------
// PHASE C — persistance
// --------------------------------------------------------------------------

interface PersistInput {
  readonly runId: string;
  readonly invocationId: string;
  readonly submitted: SubmittedDispatchInputs;
  readonly proposals: readonly ProposedAdduction[];
}

type PersistResult =
  | { readonly kind: 'PERSISTED'; readonly entries: readonly AdductionRecordedEntry[]; readonly evidence_revision: string }
  | { readonly kind: 'REFUSED'; readonly refusal: RevalidationRefusal };

/**
 * Relit, revalide **tout**, puis écrit — dans cet ordre, sous un verrou neuf.
 *
 * Tout ou rien : la matrice s'applique à **toutes** les propositions avant le
 * premier octet écrit, et l'append du lot est une opération unique. Un seul
 * échec laisse `MODEL_ASSISTED_ADDUCTIONS_PERSISTED = 0` pour ce lot ; aucune
 * persistance partielle, aucun état `PARTIALLY_VALIDATED`, `PENDING_REVIEW` ni
 * `PROVISIONAL` n'existe.
 *
 * La garantie établie ici est **exactement** celle-ci, et pas une de plus :
 *
 * ```text
 * REVALIDATION DÉTERMINISTE   TOUT OU RIEN   AVANT LE PREMIER APPEND MÉTIER
 * ```
 *
 * Aucune atomicité de système de fichiers n'est promise au-delà de ce que la
 * primitive JSONL de S2 garantit déjà.
 */
async function persistModelAdductions(
  deps: ModelAdductionDeps,
  input: PersistInput,
): Promise<PersistResult> {
  const paths = runPaths(deps.runsDir, input.runId);

  return withNativeMutation(
    { runsDir: deps.runsDir, runId: input.runId, command: 'v4-adduce-model-persist' },
    async () => {
      // Relecture canonique : les faits du moment du dispatch ne sont jamais
      // réutilisés comme s'ils étaient courants.
      const snapshot = await readStableNativeRunSnapshot(deps.runsDir, input.runId);
      const ctx = revalidationContextOf(snapshot);

      for (let index = 0; index < input.proposals.length; index += 1) {
        const proposal = input.proposals[index] as ProposedAdduction;
        const refusal = revalidateProposal(
          ctx,
          input.submitted,
          proposal,
          `proposals[${String(index)}]`,
        );
        if (refusal !== undefined) return { kind: 'REFUSED', refusal };
      }

      // Séquence allouée depuis l'état autoritaire, sous ce verrou. Aucun
      // identifiant historique n'est réutilisé, aucun n'est deviné.
      let maxAdduction = 0;
      for (const entry of snapshot.evidence) {
        if (entry.kind === 'ADDUCTION_RECORDED') {
          maxAdduction = Math.max(maxAdduction, parseAdductionSequence(entry.entry_id) ?? 0);
        }
      }
      const recordedAt = deps.now().toISOString();
      const inputs = derivationInputsOf(input.submitted);

      const candidates: AdductionRecordedEntry[] = input.proposals.map((proposal, index) => ({
        schema_version: EVIDENCE_SCHEMA_VERSION,
        entry_id: formatAdductionId(maxAdduction + index + 1),
        kind: 'ADDUCTION_RECORDED',
        // Le serveur enregistre. Le fournisseur n'est ni l'acteur, ni l'origine.
        recorded_by: 'CCR',
        recorded_at: recordedAt,
        material_id: proposal.material_id,
        // La sorte est posée par le serveur : une seule est admise.
        target: { kind: 'CONTROVERSY_ENTRY', entry_id: proposal.target_entry_id },
        // Reprise telle quelle. Aucun défaut, aucune reconstruction.
        orientation: proposal.orientation,
        semantic_origin: 'CCR',
        derivation: {
          method: 'MODEL_ASSISTED',
          invocation_id: input.invocationId,
          // Les entrées de la phase A, jamais un état de phase C enrichi.
          inputs,
        },
        ...(proposal.citation === undefined ? {} : { citation: proposal.citation }),
      }));

      // Unique écriture durable du lot. `appendEvidenceEntries` valide les N
      // entrées, refuse toute corruption terminée, normalise un fragment non
      // écrit, puis ajoute les lignes — le tout sous ce verrou.
      const written = await appendEvidenceEntries(paths, candidates);
      const after = await readEvidenceJournal(paths);
      return {
        kind: 'PERSISTED',
        entries: written as readonly AdductionRecordedEntry[],
        evidence_revision: after.revision,
      };
    },
  );
}

// --------------------------------------------------------------------------
// Orchestration
// --------------------------------------------------------------------------

/**
 * Exécute une demande d'adduction assistée par modèle.
 *
 * ```text
 * PROVIDER_EFFECT   AT_MOST(1)
 * ```
 *
 * Un seul appel, jamais deux. Aucun échec — de fournisseur, d'analyse, de
 * revalidation ou de persistance — ne déclenche une seconde tentative, ni une
 * demande de correction au modèle, ni un repli sur un autre fournisseur. Un
 * nouveau geste humain crée une **nouvelle** invocation, avec sa propre identité
 * et son propre engagement de budget.
 *
 * Aucune surface publique n'appelle cette fonction : la disponibilité runtime
 * appartient à la section 3/3, et aucun tour, aucune mutation humaine, aucun
 * rafraîchissement et aucune lecture ne la déclenchent. Elle représente un geste
 * explicite, et rien d'autre.
 *
 * ## Après engagement, sans retour
 *
 * Si le processus est interrompu après `DISPATCH_COMMITTED` et avant qu'un
 * résultat soit établi, aucune des cinq issues n'est rendue — parce qu'aucun
 * code ne s'exécute. L'état se **lit** alors dans ce qui existe déjà :
 * engagement présent au ledger, usage absent ou `UNOBSERVED`, aucune adduction
 * `MODEL_ASSISTED`, aucun `pending_operation`, aucune Recovery. Ce module ne
 * canonise ce cas nulle part, et il est **interdit** de le convertir en
 * `PROVIDER_FAILED` : cette fausse équivalence affirmerait que rien n'a été
 * consommé, ce que CCR ignore précisément.
 */
export async function adduceMaterialByModel(
  deps: ModelAdductionDeps,
  request: ModelAdductionRequest,
  seams: ModelAdductionSeams = {},
): Promise<ModelAdductionOutcome> {
  const paths = runPaths(deps.runsDir, request.runId);

  // ---- PHASE A. Verrou court : rien d'externe ne s'exécute dedans. Un refus
  // de périmètre lève ici, sans quota consommé et sans engagement.
  const plan = await planAdduction(deps, request, seams);

  // ---- PHASE B. Hors verrou. Un seul appel, sans reprise ni second essai.
  await seams.beforeProvider?.();
  const adapters = deps.createAdapters(plan.cwd, plan.runtime);
  let turn: AgentTurnResult;
  try {
    turn = await adapters[plan.provider].start(plan.prompt);
  } catch (error) {
    // L'invocation reste un fait durable. Aucune observation d'usage n'est
    // inventée, et surtout aucune adduction.
    // Issue commitée AVANT d'être rendue. `UNEXPECTED` demeure la valeur
    // publique du résultat, mais n'est jamais persistée : un code inconnu
    // s'omet plutôt que de se déguiser en cause.
    await commitNegativeOutcome(
      deps,
      request.runId,
      'v4-adduce-model-outcome',
      plan.invocationId,
      error instanceof CcrError
        ? { kind: 'V4_PROVIDER_FAILED', error_code: error.code }
        : { kind: 'V4_PROVIDER_FAILED' },
    );
    return {
      kind: 'PROVIDER_FAILED',
      invocation_id: plan.invocationId,
      error_code: error instanceof CcrError ? error.code : 'UNEXPECTED',
    };
  }

  // ---- Usage observé, sous son propre verrou court. Le verrou n'étant pas
  // réentrant, c'est une acquisition distincte de celle de la phase C.
  await withNativeMutation(
    { runsDir: deps.runsDir, runId: request.runId, command: 'v4-adduce-model-usage' },
    async () => {
      const recorder = createUsageRecorder(
        await (seams.openUsageLedger ?? openUsageLedger)(paths, request.runId),
        plan.invocationId,
        deps.now,
      );
      await recordTurnUsage(recorder, turn);
    },
  );

  // ---- ANALYSE. Le parseur de la section 1/3 fait autorité, et il est le seul :
  // aucune seconde validation de schéma, aucun transtypage, aucune réparation.
  const parsed = parseAdductionProposals(turn.content);
  if (parsed.outcome === 'INVALID') {
    // Une sortie inexploitable a parfaitement pu consommer une invocation.
    // Le vocabulaire de motif est celui de cette opération, conservé tel
    // quel : il n'est ni traduit, ni fusionné avec ceux des autres familles.
    await commitNegativeOutcome(deps, request.runId, 'v4-adduce-model-outcome', plan.invocationId, {
      kind: 'V4_INVALID_OUTPUT',
      reason: parsed.reason,
      at: parsed.at,
    });
    return {
      kind: 'INVALID_OUTPUT',
      invocation_id: plan.invocationId,
      reason: parsed.reason,
      at: parsed.at,
    };
  }
  if (parsed.proposals.length === 0) {
    // Succès opérationnel du chemin modèle. Ne signifie ni « aucune preuve »,
    // ni « aucune relation », ni accord, ni absence de contradiction, ni
    // absence de matière pertinente.
    return { kind: 'VALID_ZERO', invocation_id: plan.invocationId };
  }

  // ---- PHASE C. Verrou neuf, relecture, matrice complète, puis lot unique.
  const persisted = await persistModelAdductions(deps, {
    runId: request.runId,
    invocationId: plan.invocationId,
    submitted: plan.submitted,
    proposals: parsed.proposals,
  });

  if (persisted.kind === 'REFUSED') {
    // Le contrôle V4 conserve son vocabulaire propre : il n'est pas ramené sur
    // celui de V5, dont les quatre valeurs décrivent d'autres vérifications.
    await commitNegativeOutcome(deps, request.runId, 'v4-adduce-model-outcome', plan.invocationId, {
      kind: 'V4_REVALIDATION_REFUSED',
      check: persisted.refusal.check,
      detail: persisted.refusal.detail,
    });
    return {
      kind: 'REVALIDATION_REFUSED',
      invocation_id: plan.invocationId,
      check: persisted.refusal.check,
      at: persisted.refusal.at,
      detail: persisted.refusal.detail,
    };
  }

  return {
    kind: 'PERSISTED',
    invocation_id: plan.invocationId,
    entries: persisted.entries,
    evidence_revision: persisted.evidence_revision,
  };
}
// ==========================================================================
// SECTION 3/3 — S7-C · Frontière de disponibilité publique
// ==========================================================================

/**
 * Trois faits **indépendants**, qu'aucun raisonnement ne doit fusionner.
 *
 * ```text
 * MODEL_ADDUCTION_IMPLEMENTED             la capacité technique existe (2/3)
 * MODEL_ADDUCTION_RUNTIME_AVAILABILITY    ce qu'un humain est autorisé à demander
 * validation fournisseur RÉELLE           NOT_TESTED tant que S10 n'a pas eu lieu
 * ```
 *
 * « Implémenté » n'implique pas « disponible ». « Éprouvé avec un adaptateur
 * doublé » n'implique pas « validé en réel ». Le précédent est celui de V2.2,
 * qui a livré l'estimateur de coût avec `PRODUCTION_PRICING_CURRENT = NONE` : la
 * capacité existait sans jamais produire un montant non validé.
 *
 * ## Deux portes, un seul pipeline
 *
 * ```text
 * requestModelAdduction            porte PUBLIQUE — refuse AVANT tout engagement
 * runControlledAcceptanceAdduction voie d'ACCEPTATION — exige son autorisation
 *
 * les deux  →  adduceMaterialByModel  →  section 2/3, sans dérogation
 * ```
 *
 * Il n'existe pas deux pipelines. La voie d'acceptation franchit la porte
 * d'**exposition publique**, et elle seule — parce qu'elle est le mécanisme par
 * lequel on décidera que cette porte peut être levée. Elle ne franchit ni le
 * quota, ni l'engagement, ni l'appel, ni le parseur, ni la revalidation, ni la
 * persistance.
 */

/** La capacité technique existe. C'est un fait sur le code, pas sur l'usage. */
export const MODEL_ADDUCTION_IMPLEMENTED = true;

export type ModelAdductionAvailability = 'NOT_AVAILABLE' | 'AVAILABLE';

/**
 * Disponibilité **publique** de l'adduction assistée par modèle.
 *
 * Ce n'est pas un diagnostic. Elle n'affirme ni qu'un fournisseur répond, ni
 * qu'un quota reste, ni qu'un adaptateur est configuré, ni qu'un identifiant
 * existe, ni qu'un matériau mérite d'être versé au débat. Elle dit une seule
 * chose — **ce qu'un humain est autorisé à déclencher à cet instant**.
 *
 * Elle est **service-autoritaire** : aucune variable d'environnement, aucun
 * fichier de validation, aucun identifiant, aucun compte d'appels, aucun état
 * runtime, aucune présence d'adaptateur ni de ledger ne la calcule. Qu'un
 * adaptateur doublé traverse tout le pipeline dans les tests ne la change pas
 * d'un iota.
 *
 * Sa levée est un **changement de code adossé à une preuve citée** — jamais un
 * fichier de validation, jamais un drapeau mutable, jamais un état runtime.
 *
 * ```text
 * PREUVE CITÉE   micro-gate REAL de S10, CALL 1, autorisé par un humain
 *                un run de fixture réel · une invocation gouvernée
 *                DISPATCH_COMMITTED · EVIDENCE_ADDUCTION · ledger v3
 *                un appel fournisseur RÉEL, un seul · sortie reçue
 *                parseur strict traversé · liaison vérifiée
 *                quatre citations confrontées au matériau détenu
 *                quatre adductions MODEL_ASSISTED persistées
 *                usage réellement observé, jamais inventé
 * ```
 *
 * `AVAILABLE` dit exactement ceci : **un humain PEUT demander une adduction**,
 * par `ccr adduce-model`. Jamais qu'une adduction se déclenche d'elle-même —
 * aucun tour, aucune lecture, aucune mutation humaine, aucun rafraîchissement
 * n'en produit.
 *
 * Ce que ce verdict n'établit pas, et qui reste `NOT_TESTED` : l'exactitude,
 * la précision, le rappel, la qualité argumentative, la robustesse, et le
 * comportement de tout autre fournisseur ou modèle.
 */
export const MODEL_ADDUCTION_RUNTIME_AVAILABILITY: ModelAdductionAvailability = 'AVAILABLE';

/**
 * Les six issues de domaine du chemin assisté, telles que le plan les énumère.
 *
 * Cinq viennent de la section 2/3 et traversent la porte **sans réécriture** ;
 * la sixième appartient à la porte elle-même. Aucune septième n'existe : ni
 * `PARTIAL`, ni `PARTIALLY_VALIDATED`, ni `RETRYING`, ni `RECOVERING`, ni un
 * statut d'incertitude après engagement — celui-ci se **lit** dans le ledger et
 * l'usage, il n'est pas rendu.
 */
export const MODEL_ADDUCTION_DOMAIN_OUTCOMES = [
  'PERSISTED',
  'VALID_ZERO',
  'NOT_AVAILABLE',
  'INVALID_OUTPUT',
  'REVALIDATION_REFUSED',
  'PROVIDER_FAILED',
] as const;
export type ModelAdductionDomainOutcome = (typeof MODEL_ADDUCTION_DOMAIN_OUTCOMES)[number];

/**
 * Issue d'une demande **publique** — union discriminée.
 *
 * Le refus n'est pas une erreur de la requête : celle-ci peut être parfaitement
 * formée. C'est l'état du runtime qui l'interdit, et le dire par une **issue**
 * plutôt que par une exception rend l'absence d'effet lisible.
 *
 * L'imbrication est délibérée. Elle rend structurellement impossible qu'un refus
 * de disponibilité soit confondu avec une issue du pipeline : un appelant ne
 * peut pas lire `adduction` sans avoir d'abord constaté `DISPATCHED`, et la
 * porte ne peut donc pas réinterpréter ce que la section 2/3 a rendu.
 */
export type PublicModelAdductionOutcome =
  | { readonly kind: 'NOT_AVAILABLE'; readonly availability: ModelAdductionAvailability }
  | { readonly kind: 'DISPATCHED'; readonly adduction: ModelAdductionOutcome };

/**
 * Demande **publique** d'adduction assistée — la seule voie qu'une surface
 * utilisateur empruntera lorsqu'il y en aura une.
 *
 * La porte est franchie **avant** toute gouvernance. Un refus :
 *
 * ```text
 * ne lit aucun run          n'alloue aucune identité
 * ne consomme aucun quota   n'engage aucune invocation
 * n'appelle aucun adaptateur   n'écrit aucun octet
 * ```
 *
 * Une porte fermée ne coûte rien — et c'est ce qui la rend vérifiable : après un
 * refus, `invocations.jsonl` et `usage.jsonl` n'existent pas, `evidence.jsonl`
 * est inchangé octet pour octet, et le compteur d'appels d'adaptateur vaut zéro.
 *
 * Aucune surface ne l'appelle aujourd'hui : le plan gelé n'active la commande
 * humaine retenue qu'**après** le verdict du micro-gate REAL.
 *
 * L'appelant ne choisit jamais la politique de disponibilité. Il n'existe ni
 * option, ni drapeau, ni champ de requête, ni variable d'environnement qui
 * permette de la contourner — la voie d'acceptation est une **fonction
 * distincte**, pas un paramètre de celle-ci.
 */
export async function requestModelAdduction(
  deps: ModelAdductionDeps,
  request: ModelAdductionRequest,
  seams: ModelAdductionSeams = {},
): Promise<PublicModelAdductionOutcome> {
  if (MODEL_ADDUCTION_RUNTIME_AVAILABILITY !== 'AVAILABLE') {
    return { kind: 'NOT_AVAILABLE', availability: MODEL_ADDUCTION_RUNTIME_AVAILABILITY };
  }
  return { kind: 'DISPATCHED', adduction: await adduceMaterialByModel(deps, request, seams) };
}

/**
 * Autorisation de la voie d'acceptation contrôlée, réservée au micro-gate REAL.
 *
 * Elle n'est **pas** un paramètre que l'on demande : aucune surface publique
 * n'en construit, et rien de ce qui vient d'un corps HTTP, d'une requête, d'un
 * cookie, du frontend, des données d'un run, du contenu d'une controverse, d'un
 * matériau ou de la sortie d'un fournisseur ne peut en produire une. Sa seule
 * origine est un appel interne écrit à la main pour ce gate.
 *
 * `humanAuthorization` consigne l'autorisation humaine explicite que le plan
 * exige. Elle n'est pas vérifiée par la machine — elle ne le pourrait pas —,
 * elle est **portée**, pour que l'appel dise qui l'a voulu.
 */
export interface ModelAdductionAcceptanceAuthorization {
  readonly gate: 'S10_REAL_ADDUCTION_ACCEPTANCE';
  readonly humanAuthorization: string;
}

/**
 * Voie d'acceptation contrôlée — ce qu'elle franchit, et ce qu'elle ne franchit
 * pas.
 *
 * ```text
 * FRANCHIT      la porte d'EXPOSITION PUBLIQUE, et elle seule —
 *               parce qu'elle EST le mécanisme qui décidera qu'on peut la lever
 *
 * NE FRANCHIT   quota · InvocationLedger · DISPATCH_COMMITTED · adaptateur
 * PAS           parseur strict · liaison V6/V7 · revalidation V2/V4/V5/V9/V10
 *               tout-ou-rien du lot · discipline de verrou · persistance
 * ```
 *
 * Elle ne lit ni n'écrit `MODEL_ADDUCTION_RUNTIME_AVAILABILITY` : la levée de la
 * porte sera un changement de code adossé à son verdict, jamais un effet de bord
 * de son exécution. Elle reste donc utilisable à l'identique pour une prochaine
 * acceptation — et aucune surface publique ne l'atteint.
 *
 * Elle appelle **le même** service gouverné que la voie publique. Il n'existe
 * donc qu'une seule autorité de quota, d'engagement, d'appel, d'analyse, de
 * liaison, de revalidation et de persistance — pas deux pipelines à faire
 * diverger.
 */
export async function runControlledAcceptanceAdduction(
  deps: ModelAdductionDeps,
  request: ModelAdductionRequest,
  authorization: ModelAdductionAcceptanceAuthorization,
  seams: ModelAdductionSeams = {},
): Promise<ModelAdductionOutcome> {
  if (authorization.gate !== 'S10_REAL_ADDUCTION_ACCEPTANCE') {
    throw new CcrError('INVALID_ARGUMENT', "La voie d'acceptation exige son autorisation de gate.", {
      details: { reason: 'ACCEPTANCE_AUTHORIZATION_REQUIRED' },
    });
  }
  if (
    typeof authorization.humanAuthorization !== 'string' ||
    authorization.humanAuthorization.length === 0
  ) {
    throw new CcrError(
      'INVALID_ARGUMENT',
      "La voie d'acceptation exige une autorisation humaine énoncée.",
      { details: { reason: 'ACCEPTANCE_AUTHORIZATION_REQUIRED' } },
    );
  }
  return adduceMaterialByModel(deps, request, seams);
}
