/**
 * Écritures métier V3 — les huit opérations sans fournisseur.
 *
 * Tranche S4 du plan gelé. Ce module est le **premier appelant métier** de
 * `appendControversyEntry`, et donc le premier à satisfaire réellement la
 * précondition que S2 avait posée sans pouvoir l'honorer :
 *
 * > Tout usage de mutation métier exige que l'appelant détienne le run lock.
 *
 * ## Une seule section critique
 *
 * Le contrat de concurrence n'est pas « vérifier une révision ». C'est vérifier
 * **et** agir dans la même sérialisation. Toute validation qui dépend du run
 * s'exécute donc sous le verrou qui portera l'append :
 *
 * ```text
 * verrou de run  →  génération native  →  BEFORE de l'appelant
 *   →  faits canoniques courants
 *   →  fraîcheur controversy_revision
 *   →  validations déterministes (autorité, ancrage, cible, doublon)
 *   →  construction SERVER-AUTHORITATIVE de l'entrée
 *   →  append
 *   →  révision résultante
 * →  SETTLED  →  release
 * ```
 *
 * Valider hors du verrou puis le prendre pour écrire serait un TOCTOU : l'état
 * de la controverse peut changer entre les deux, et la validation porterait sur
 * un monde révolu.
 *
 * ## Ce que l'appelant ne peut pas forger
 *
 * Ce module est un **service métier**, pas une façade sur le journal. Aucune
 * entrée fournie par un appelant n'est recopiée : chaque champ dont CCR est
 * l'autorité technique est construit ici.
 *
 * ```text
 * entry_id · controversy_id · schema_version · recorded_at · recorded_by
 * round · semantic_origin · anchors[].round · anchors[].expert_slot_id
 * anchors[].session_id · l'acte d'autorité
 * ```
 *
 * ## Frontière sans fournisseur
 *
 * `PROVIDER EFFECT = EXACT(0)` pour les huit opérations. Aucun adapter, aucun
 * sous-processus, aucun dispatch, aucun `InvocationLedger`.
 *
 * `MODEL_ASSISTED` n'est pas *refusé* ici : il est **inexprimable**. Les DTO
 * n'exposent ni `semantic_origin`, ni `derivation`, ni `invocation_id`, et les
 * entrées sont construites champ par champ. Une entrée assistée par modèle
 * n'existe que par le service de détection S7, après gouvernance V2.2 — sans
 * quoi une attribution mensongère serait possible sans qu'aucune invocation
 * n'ait eu lieu.
 *
 * Aucune opération S4 ne produit `kind = SOURCE`, et aucune ne produit
 * `kind = CCR` : les huit opérations du plan sont toutes d'autorité humaine.
 */

import { CcrError } from '../core/errors.ts';
import type { ExpertSlotId } from '../core/expert.ts';
import type { NativeCcrEvent } from '../core/run-native.ts';
import {
  CONTROVERSY_SCHEMA_VERSION,
  formatControversyEntryId,
  formatControversyId,
  parseControversyEntrySequence,
  parseControversySequence,
  validateControversyEntry,
} from '../core/controversy.ts';
import type {
  ControversyAnchors,
  ControversyEntry,
  ControversyEntryKind,
  Derivation,
  ProvenanceAnchor,
  RelationAct,
  TextualAnchor,
} from '../core/controversy.ts';
import { runPaths } from '../store/layout.ts';
import { appendControversyEntry, readControversyJournal } from '../store/controversy-store.ts';
import { readStableNativeRunSnapshot } from '../store/native-run-snapshot.ts';
import type { NativeRunSnapshot } from '../store/native-run-snapshot.ts';
import { withNativeMutation } from './native-mutation-boundary.ts';
import type { NativeMutationBoundary } from './native-mutation-boundary.ts';
import { utf8ByteLength } from './transfer.ts';

// --------------------------------------------------------------------------
// Bornes de contenu
// --------------------------------------------------------------------------

/**
 * Plafond des textes métier V3, en octets UTF-8.
 *
 * Aucun nombre n'est inventé : le plan gelé demande de réutiliser les plafonds
 * existants comme motif, et les cinq champs V3 qu'il cartographie renvoient
 * tous à la même valeur du dépôt.
 *
 * ```text
 * quoted_text · énoncé sémantique   plafond de contenu transmis   256 KiB
 * nature · périmètre d'autorité      plafond d'acquittement        256 KiB
 * contenu d'autorité humaine         plafond de contenu décision   256 KiB
 * ```
 *
 * Un seul constante est donc fidèle, et non une simplification : les trois
 * plafonds cités valent la même chose dans `mutations-http.ts`. Le plafond de
 * corps de requête (1 MiB) reste celui du transport, et la sortie brute du
 * détecteur appartient à S7.
 *
 * Refus plutôt que troncature, comme le garde-fou de transfert : un texte
 * tronqué serait cité comme s'il était complet.
 */
export const MAX_CONTROVERSY_TEXT_BYTES = 256 * 1024;

/** Effet fournisseur des huit opérations S4, sans exception. */
export const CONTROVERSY_PROVIDER_EFFECT = 'EXACT(0)';

// --------------------------------------------------------------------------
// Motifs de refus — publics, stables, portés par `details.reason`
// --------------------------------------------------------------------------

/**
 * Motifs de refus déterministes.
 *
 * Aucun code d'erreur nouveau n'est ajouté à `CcrErrorCode` : le plan gelé
 * n'alloue pas `core/errors.ts` à S4, et les codes existants portent déjà la
 * distinction qui compte pour un appelant — argument invalide, vue périmée,
 * journal illisible, génération non supportée. Le motif précis voyage dans
 * `details.reason`, où il est public et stable.
 *
 * `ANCHOR_UNRESOLVABLE` reste le nom de la **projection** d'un ancrage qui ne
 * se résout pas (contrat §8.2, §19) — S3 le porte déjà. Ici, l'écriture est
 * refusée avant d'en produire un.
 */
export const CONTROVERSY_REFUSAL_REASONS = [
  'CONTENT_TOO_LARGE',
  'PROVENANCE_REQUIRED',
  'PROVENANCE_EVENT_NOT_FOUND',
  'CONTROVERSY_NOT_FOUND',
  'CONTROVERSY_ALREADY_RECORDED',
  'ENTRY_NOT_FOUND',
  'ENTRY_OUTSIDE_CONTROVERSY',
  'RELATION_SELF_REFERENCE',
  'RELATION_ENDPOINT_KIND_FORBIDDEN',
  'RELATION_TARGET_NOT_ASSERTION',
  'AUTHORITY_TARGET_NOT_CCR_RELATION',
  'ANCHOR_EVENT_NOT_FOUND',
  'ANCHOR_CONTENT_UNAVAILABLE',
  'ANCHOR_OCCURRENCE_NOT_FOUND',
  'ANCHOR_SOURCE_NOT_ATTRIBUTABLE',
  'ABOUT_ACTOR_MISMATCH',
  'EXACT_DUPLICATE',
  /**
   * Provenance d'une détection — deux motifs propres à `MODEL_ASSISTED`.
   *
   * Ils ne s'appliquent à aucune relation humaine : un humain ne se voit
   * soumettre aucun périmètre, et sa relation n'a aucun ensemble d'entrées
   * « effectivement fournies » à respecter.
   */
  'DETECTION_SCOPE_MISMATCH',
  'DETECTION_ENDPOINT_NOT_SUBMITTED',
] as const;
export type ControversyRefusalReason = (typeof CONTROVERSY_REFUSAL_REASONS)[number];

function refuse(
  reason: ControversyRefusalReason,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): CcrError {
  return new CcrError('INVALID_ARGUMENT', message, { details: { reason, ...details } });
}

// --------------------------------------------------------------------------
// Dépendances et formes d'entrée
// --------------------------------------------------------------------------

/**
 * Dépendances du service — volontairement sans fabrique d'adapter.
 *
 * L'absence de `createAdapters` n'est pas une omission : c'est la preuve, au
 * niveau du type, qu'aucun fournisseur ne peut être invoqué depuis ce module.
 */
export interface ControversyServiceDeps {
  readonly runsDir: string;
  now(): Date;
}

/** Ancrage textuel tel que l'appelant le fournit. La forme est validée par S1. */
export interface TextualAnchorInput {
  readonly event_id: string;
  readonly quoted_text: string;
  /** Rang 1-based, fourni — jamais déduit. Les chevauchements sont comptés. */
  readonly occurrence: number;
}

interface RunScopedInput {
  readonly runId: string;
  /**
   * Jeton de fraîcheur du **domaine V3**, obtenu d'un snapshot stable.
   *
   * Jamais fabriqué par un client. Ce n'est pas non plus une exemption aux
   * admissions du run : la révision de run reste la précondition de l'appelant,
   * portée par `boundary.before`.
   */
  readonly expected_controversy_revision: string;
}

interface ProvenanceInput extends RunScopedInput {
  /**
   * Événements canoniques dont l'entrée tire sa provenance.
   *
   * L'appelant nomme les événements ; CCR construit les ancrages. Le tour, le
   * slot et la session sont recopiés depuis l'événement, jamais reçus.
   */
  readonly provenance_event_ids: readonly string[];
}

interface ControversyScopedInput extends ProvenanceInput {
  readonly controversy_id: string;
}

export interface RecordControversyInput extends ProvenanceInput {
  /** Motif de l'enregistrement. N'affirme pas qu'un désaccord est établi. */
  readonly statement: string;
  readonly textual_anchor?: TextualAnchorInput;
}

/**
 * Transcription humaine à propos d'une source (`docs/specs/controversy.md`).
 *
 * Aucun `semantic_origin` n'est reçu : l'origine est `HUMAN` avec
 * `about_actor`, et il n'existe aucun chemin qui produise `SOURCE`. L'ancrage
 * textuel est obligatoire — sans lui, l'attribution ne serait vérifiable par
 * personne.
 */
export interface RecordHumanTranscriptionInput extends RunScopedInput {
  readonly controversy_id: string;
  readonly about_actor: ExpertSlotId;
  readonly anchor: TextualAnchorInput;
  /** L'unité sémantique transcrite. Au plus une, par la forme. */
  readonly statement: string;
  readonly note?: string;
}

/**
 * Assertion humaine simple.
 *
 * N'accepte **pas** `about_actor` : une sémantique attribuée à une source passe
 * obligatoirement par la transcription, qui exige un ancrage textuel. Exposer
 * `about_actor` ici rouvrirait une attribution sans passage vérifiable.
 */
export interface RecordAssertionInput extends ProvenanceInput {
  readonly controversy_id: string;
  readonly statement: string;
  readonly textual_anchor?: TextualAnchorInput;
  readonly note?: string;
}

export interface RecordRelationInput extends ControversyScopedInput {
  readonly act: RelationAct;
  readonly from_entry_id: string;
  readonly to_entry_id: string;
  readonly note?: string;
}

export interface RecordNatureInput extends ControversyScopedInput {
  /**
   * Qualification proposée — vocabulaire **ouvert**.
   *
   * `A9` est fermé sur le principe : la qualification est facultative et
   * attribuée. Le vocabulaire, lui, reste non exhaustif : aucune énumération
   * fermée n'est imposée, et aucune conséquence automatique n'en découle.
   */
  readonly nature: string;
}

export interface RecordHumanAuthorityInput extends ControversyScopedInput {
  /** Périmètre arbitré, énoncé. Strictement V3, jamais une décision de run. */
  readonly scope: string;
  readonly target_entry_id?: string;
  readonly content?: string;
}

export interface RespondToInferredRelationInput extends ControversyScopedInput {
  /** L'inférence de relation visée. Jamais modifiée. */
  readonly target_entry_id: string;
  readonly content?: string;
}

/**
 * Ce qu'une mutation rend, et rien de plus.
 *
 * Pas de vue regroupée, pas de seconde autorité sur l'état courant : un
 * appelant qui a besoin de la lecture complète la relit par S3. Deux sources de
 * regroupement finiraient par diverger.
 */
export interface ControversyMutationResult {
  readonly entry: ControversyEntry;
  readonly controversy_id: string;
  /** Révision de la source **après** l'append, calculée sous le même verrou. */
  readonly controversy_revision: string;
  readonly provider_effect: typeof CONTROVERSY_PROVIDER_EFFECT;
}

// --------------------------------------------------------------------------
// Bornes, occurrences, provenance
// --------------------------------------------------------------------------

function requireBounded(value: string, field: string): string {
  const bytes = utf8ByteLength(value);
  if (bytes > MAX_CONTROVERSY_TEXT_BYTES) {
    throw refuse('CONTENT_TOO_LARGE', `${field} dépasse la borne d'écriture V3 : refus, jamais troncature.`, {
      field,
      bytes,
      max_bytes: MAX_CONTROVERSY_TEXT_BYTES,
    });
  }
  return value;
}

/**
 * Occurrences exactes, **chevauchements compris**, rang 1-based.
 *
 * La recherche reprend à `start + 1`, jamais à `start + longueur` : deux
 * comptages différents donneraient deux rangs pour le même ancrage, et
 * l'ancrage cesserait d'être déterministe. Aucune normalisation — ni Unicode,
 * ni fins de ligne : le contenu canonique fait foi tel qu'il est.
 *
 * Même règle que la projection S3. Les deux implémentations sont épinglées
 * l'une à l'autre par un test de conformité croisée.
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

/**
 * Le slot qui a **produit** le contenu de l'événement, lorsqu'il est établi.
 *
 * Seuls les événements de session d'expert portent une paternité : le module
 * natif les décrit comme « l'événement EST le tour d'un expert ». Un événement
 * adressé *à* un expert n'est pas produit par lui, et un transfert en concerne
 * deux.
 *
 * C'est exactement le niveau N1 du contrat — « Challenger a produit tel
 * texte » —, et rien au-delà.
 */
function authoringSlot(event: NativeCcrEvent): ExpertSlotId | undefined {
  return 'expert_slot_id' in event ? event.expert_slot_id : undefined;
}

/** Le slot que l'événement concerne, quand il n'en concerne qu'un. */
function singleSlotOf(event: NativeCcrEvent): ExpertSlotId | undefined {
  const authored = authoringSlot(event);
  if (authored !== undefined) return authored;
  return 'target_expert_slot_id' in event ? event.target_expert_slot_id : undefined;
}

/**
 * Ancrage de provenance construit **depuis l'événement canonique**.
 *
 * Le tour est recopié, le slot et la session sont lus. Rien n'est reçu de
 * l'appelant hormis l'identifiant de l'événement : une provenance calculable
 * côté serveur ne doit pas pouvoir être déclarée.
 */
function provenanceFromEvent(event: NativeCcrEvent): ProvenanceAnchor {
  const slot = singleSlotOf(event);
  const sessionId = 'session_id' in event ? event.session_id : undefined;
  return {
    event_id: event.event_id,
    round: event.round,
    ...(slot === undefined ? {} : { expert_slot_id: slot }),
    ...(typeof sessionId === 'string' && sessionId.length > 0 ? { session_id: sessionId } : {}),
  };
}

// --------------------------------------------------------------------------
// Doublon exact — contrat §18
// --------------------------------------------------------------------------

/** Sérialisation canonique : clés triées, donc indépendante de l'ordre d'écriture. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

/**
 * Empreinte d'un doublon **exact**, au sens exact du contrat.
 *
 * ```text
 * même kind · même controverse · même attribution · mêmes ancrages · même contenu
 * ```
 *
 * Cinq composantes, énumérées par le contrat §18, et pas une de plus :
 * `entry_id`, `recorded_at` et `round` en sont absents — les inclure rendrait la
 * garde vide, puisqu'un horodatage diffère toujours.
 *
 * La charge de relation entre dans « même contenu » : le contrat §17.2 la
 * précise comme « même triplet `from`/`to`/`act`/origine ».
 *
 * Un doublon **sémantique** — deux formulations proches du même point — n'est
 * jamais dédupliqué : ce serait une inférence non attribuée.
 */
function exactDuplicateKey(entry: ControversyEntry): string {
  return canonicalJson({
    kind: entry.kind,
    controversy_id: entry.controversy_id,
    semantic_origin: entry.semantic_origin,
    recorded_by: entry.recorded_by,
    anchors: entry.anchors,
    content: entry.content ?? null,
    relation: entry.relation ?? null,
  });
}

/**
 * Les types dont un doublon exact est refusé.
 *
 * `HUMAN_AUTHORITY_RECORDED` en est **exclu**, et le contrat le dit : « non
 * idempotent — deux autorités distinctes sont légitimes, y compris successives
 * sur la même cible ». Confirmer deux fois est un second geste humain, pas une
 * retransmission.
 */
const DUPLICATE_GUARDED_KINDS: readonly ControversyEntryKind[] = [
  'ASSERTION_RECORDED',
  'RELATION_RECORDED',
  'NATURE_RECORDED',
];

// --------------------------------------------------------------------------
// Contexte de mutation — établi sous le verrou
// --------------------------------------------------------------------------

interface MutationContext {
  readonly snapshot: NativeRunSnapshot;
  readonly entries: readonly ControversyEntry[];
  readonly events: ReadonlyMap<string, NativeCcrEvent>;
  readonly byEntryId: ReadonlyMap<string, ControversyEntry>;
  readonly round: number;
  readonly recordedAt: string;
  /** Identité de controverse allouée par le serveur, pour une création. */
  allocateControversyId(): string;
  allocateEntryId(): string;
}

/**
 * Établit le contexte d'une mutation depuis un snapshot déjà lu **sous verrou**.
 *
 * Extrait pour être partagé par les huit opérations humaines et par la
 * persistance de détection : les deux allouent leurs identités depuis le même
 * état autoritaire, et dupliquer ce calcul en créerait deux — donc, tôt ou
 * tard, deux séquences divergentes.
 */
function buildMutationContext(snapshot: NativeRunSnapshot, recordedAt: string): MutationContext {
  const entries = snapshot.controversies;

  const events = new Map<string, NativeCcrEvent>();
  for (const event of snapshot.events) events.set(event.event_id, event);

  const byEntryId = new Map<string, ControversyEntry>();
  let maxEntry = 0;
  let maxControversy = 0;
  for (const entry of entries) {
    byEntryId.set(entry.entry_id, entry);
    maxEntry = Math.max(maxEntry, parseControversyEntrySequence(entry.entry_id) ?? 0);
    maxControversy = Math.max(maxControversy, parseControversySequence(entry.controversy_id) ?? 0);
  }

  // Allocation déterministe depuis l'état autoritaire : aucun compteur
  // persistant parallèle, et aucune collision possible tant que le verrou
  // couvre la lecture et l'append.
  let allocatedEntries = 0;
  let allocatedControversies = 0;

  return {
    snapshot,
    entries,
    events,
    byEntryId,
    round: snapshot.state.round,
    recordedAt,
    allocateControversyId: (): string => {
      allocatedControversies += 1;
      return formatControversyId(maxControversy + allocatedControversies);
    },
    allocateEntryId: (): string => {
      allocatedEntries += 1;
      return formatControversyEntryId(maxEntry + allocatedEntries);
    },
  };
}

function resolveEvent(ctx: MutationContext, eventId: string, reason: ControversyRefusalReason): NativeCcrEvent {
  const event = ctx.events.get(eventId);
  if (event === undefined) {
    throw refuse(reason, `Aucun événement canonique ${eventId} dans ce run.`, { event_id: eventId });
  }
  return event;
}

function buildProvenance(ctx: MutationContext, eventIds: readonly string[]): readonly ProvenanceAnchor[] {
  if (!Array.isArray(eventIds) || eventIds.length === 0) {
    throw refuse('PROVENANCE_REQUIRED', 'Toute entrée V3 porte au moins un ancrage de provenance.');
  }
  return eventIds.map((eventId) => provenanceFromEvent(resolveEvent(ctx, eventId, 'PROVENANCE_EVENT_NOT_FOUND')));
}

/**
 * Résout un ancrage textuel contre les **faits canoniques**, sous le verrou.
 *
 * Jamais contre une copie fournie par l'appelant : la citation est une copie de
 * vérification, et c'est le contenu de l'événement qui fait foi.
 */
function resolveTextualAnchor(ctx: MutationContext, input: TextualAnchorInput): TextualAnchor {
  requireBounded(input.quoted_text, 'quoted_text');
  const event = resolveEvent(ctx, input.event_id, 'ANCHOR_EVENT_NOT_FOUND');

  const content = event.content;
  if (typeof content !== 'string') {
    throw refuse('ANCHOR_CONTENT_UNAVAILABLE', `L'événement ${input.event_id} ne porte aucun contenu citable.`, {
      event_id: input.event_id,
    });
  }

  // La forme — citation non vide, rang entier strictement positif — est déjà
  // la règle de S1 ; elle est réappliquée ici avant toute recherche, pour que
  // le refus soit celui de l'ancrage et non celui de l'entrée entière.
  if (typeof input.quoted_text !== 'string' || input.quoted_text.length === 0) {
    throw refuse('ANCHOR_OCCURRENCE_NOT_FOUND', 'Une citation vide ne désigne aucune position.', {
      event_id: input.event_id,
    });
  }
  if (!Number.isInteger(input.occurrence) || input.occurrence < 1) {
    throw refuse('ANCHOR_OCCURRENCE_NOT_FOUND', "L'occurrence est un rang 1-based, fourni et jamais déduit.", {
      event_id: input.event_id,
      occurrence: input.occurrence,
    });
  }

  if (!occurrenceExists(content, input.quoted_text, input.occurrence)) {
    throw refuse(
      'ANCHOR_OCCURRENCE_NOT_FOUND',
      `La citation demandée n'a pas d'occurrence ${String(input.occurrence)} dans ${input.event_id}.`,
      { event_id: input.event_id, occurrence: input.occurrence },
    );
  }

  // Aucun décalage n'est stocké : la citation et son rang suffisent, et se
  // confrontent à l'original.
  return { event_id: input.event_id, quoted_text: input.quoted_text, occurrence: input.occurrence };
}

function requireRecordedControversy(ctx: MutationContext, controversyId: string): void {
  if (parseControversySequence(controversyId) === undefined) {
    throw refuse('CONTROVERSY_NOT_FOUND', `controversy_id non canonique (${controversyId}).`, {
      controversy_id: controversyId,
    });
  }
  const recorded = ctx.entries.some(
    (entry) => entry.controversy_id === controversyId && entry.kind === 'CONTROVERSY_RECORDED',
  );
  if (!recorded) {
    throw refuse('CONTROVERSY_NOT_FOUND', `Aucune controverse ${controversyId} enregistrée dans ce run.`, {
      controversy_id: controversyId,
    });
  }
}

function requireEntryInControversy(
  ctx: MutationContext,
  entryId: string,
  controversyId: string,
): ControversyEntry {
  if (parseControversyEntrySequence(entryId) === undefined) {
    throw refuse('ENTRY_NOT_FOUND', `entry_id non canonique (${entryId}).`, { entry_id: entryId });
  }
  const entry = ctx.byEntryId.get(entryId);
  if (entry === undefined) {
    throw refuse('ENTRY_NOT_FOUND', `Aucune entrée ${entryId} dans ce run.`, { entry_id: entryId });
  }
  if (entry.controversy_id !== controversyId) {
    // Portée A5 : une relation ou une autorité ne franchit pas la frontière
    // d'une controverse. Rien ne dit que deux controverses portent sur la même
    // chose, et l'affirmer serait une inférence non attribuée.
    throw refuse(
      'ENTRY_OUTSIDE_CONTROVERSY',
      `L'entrée ${entryId} appartient à ${entry.controversy_id}, pas à ${controversyId}.`,
      { entry_id: entryId, controversy_id: controversyId, actual_controversy_id: entry.controversy_id },
    );
  }
  return entry;
}

// --------------------------------------------------------------------------
// Frontière commune — verrou, fraîcheur, validation, append
// --------------------------------------------------------------------------

/**
 * Exécute une mutation métier V3 de bout en bout, sous **un seul** verrou.
 *
 * L'ordre est le contrat lui-même : la fraîcheur est comparée avant toute
 * validation métier, et toute validation précède l'unique écriture durable. Un
 * refus, quel qu'il soit, laisse le journal — et son absence — intacts.
 */
async function runControversyMutation(
  deps: ControversyServiceDeps,
  runId: string,
  command: string,
  expectedRevision: string,
  build: (ctx: MutationContext) => ControversyEntry,
  boundary?: NativeMutationBoundary,
): Promise<ControversyMutationResult> {
  const paths = runPaths(deps.runsDir, runId);

  return withNativeMutation(
    {
      runsDir: deps.runsDir,
      runId,
      command,
      ...(boundary === undefined ? {} : { boundary }),
    },
    async () => {
      // Faits canoniques courants. Le snapshot refuse un run historique, lève
      // sur un journal corrompu ou de version inconnue, et rend la révision V3
      // calculée par la sémantique de S2 — jamais une variante locale.
      const snapshot = await readStableNativeRunSnapshot(deps.runsDir, runId);

      if (snapshot.controversy_revision !== expectedRevision) {
        // Avant toute validation métier et avant tout octet écrit : une vue
        // périmée invalide la demande entière, pas seulement sa cible.
        throw new CcrError(
          'STALE_REVISION',
          `La controverse du run ${runId} a changé depuis la vue de l'appelant : aucune écriture n'est tentée.`,
          {
            details: {
              runId,
              expected_controversy_revision: expectedRevision,
              actual_controversy_revision: snapshot.controversy_revision,
            },
          },
        );
      }

      const ctx = buildMutationContext(snapshot, deps.now().toISOString());
      const entries = ctx.entries;

      const candidate = validateControversyEntry(build(ctx));

      if (DUPLICATE_GUARDED_KINDS.includes(candidate.kind)) {
        const key = exactDuplicateKey(candidate);
        if (entries.some((entry) => exactDuplicateKey(entry) === key)) {
          throw refuse('EXACT_DUPLICATE', "Cette entrée existe déjà à l'identique dans ce journal.", {
            controversy_id: candidate.controversy_id,
            kind: candidate.kind,
          });
        }
      }

      // Unique écriture durable. `appendControversyEntry` relit, refuse toute
      // corruption terminée, normalise un fragment non écrit, puis ajoute une
      // ligne complète — le tout dans ce verrou, comme S2 l'exigeait.
      const written = await appendControversyEntry(paths, candidate);

      const after = await readControversyJournal(paths);
      return {
        entry: written,
        controversy_id: written.controversy_id,
        controversy_revision: after.revision,
        provider_effect: CONTROVERSY_PROVIDER_EFFECT,
      };
    },
  );
}

// --------------------------------------------------------------------------
// 1. Enregistrer une controverse
// --------------------------------------------------------------------------

/**
 * Enregistre une controverse et lui donne une identité.
 *
 * L'identité est **épistémiquement neutre** : elle atteste qu'un enregistrement
 * existe, jamais qu'un désaccord est établi. Aucun état n'est créé — ni ouvert,
 * ni actif —, aucune nature n'est déduite, aucun gagnant n'est désigné, et
 * aucun modèle n'est appelé.
 */
export async function recordControversy(
  deps: ControversyServiceDeps,
  input: RecordControversyInput,
  boundary?: NativeMutationBoundary,
): Promise<ControversyMutationResult> {
  return runControversyMutation(
    deps,
    input.runId,
    'v3-record-controversy',
    input.expected_controversy_revision,
    (ctx) => {
      requireBounded(input.statement, 'statement');
      const provenance = buildProvenance(ctx, input.provenance_event_ids);
      const controversyId = ctx.allocateControversyId();

      // Le contrat refuse deux enregistrements sous la même identité. Une
      // identité allouée sous le verrou ne peut pas entrer en collision ; la
      // garde reste écrite parce que c'est la règle, non parce qu'on en doute.
      if (ctx.entries.some((entry) => entry.controversy_id === controversyId)) {
        throw refuse('CONTROVERSY_ALREADY_RECORDED', `La controverse ${controversyId} existe déjà.`, {
          controversy_id: controversyId,
        });
      }

      const anchors: ControversyAnchors = {
        provenance,
        ...(input.textual_anchor === undefined
          ? {}
          : { textual: resolveTextualAnchor(ctx, input.textual_anchor) }),
      };

      return {
        schema_version: CONTROVERSY_SCHEMA_VERSION,
        entry_id: ctx.allocateEntryId(),
        controversy_id: controversyId,
        kind: 'CONTROVERSY_RECORDED',
        semantic_origin: { kind: 'HUMAN' },
        recorded_by: 'HUMAN',
        recorded_at: ctx.recordedAt,
        round: ctx.round,
        anchors,
        content: input.statement,
      };
    },
    boundary,
  );
}

// --------------------------------------------------------------------------
// 2. Transcrire à propos d'une source
// --------------------------------------------------------------------------

/**
 * Enregistre la lecture structurée qu'un humain fait d'une production d'expert.
 *
 * ```text
 * kind        HUMAN — jamais SOURCE
 * about_actor le slot dont la production est lue
 * ancrage     TEXTUEL, OBLIGATOIRE, résolu contre le contenu canonique
 * ```
 *
 * `AUDITABLE ≠ SOURCE-AUTHORED` : l'ancrage rend la transcription vérifiable
 * par quiconque, il ne la rend pas produite par la source. Le choix de ce qui
 * compte comme l'assertion, sa formulation et sa portée restent ceux de
 * l'humain, et l'entrée le dit.
 *
 * L'événement ancré doit porter une **paternité** établie, et celle-ci doit
 * être `about_actor`. Un humain ne peut donc pas déclarer transcrire le
 * challenger en citant une production canoniquement attribuée à l'author.
 * Lorsque l'événement ne porte aucune paternité — il s'adresse à un expert,
 * ou n'a aucune identité —, l'écriture est refusée plutôt qu'attribuée : la
 * vérification est structurelle, jamais textuelle.
 */
export async function recordHumanTranscription(
  deps: ControversyServiceDeps,
  input: RecordHumanTranscriptionInput,
  boundary?: NativeMutationBoundary,
): Promise<ControversyMutationResult> {
  return runControversyMutation(
    deps,
    input.runId,
    'v3-record-human-transcription',
    input.expected_controversy_revision,
    (ctx) => {
      requireBounded(input.statement, 'statement');
      if (input.note !== undefined) requireBounded(input.note, 'note');
      requireRecordedControversy(ctx, input.controversy_id);

      const textual = resolveTextualAnchor(ctx, input.anchor);
      const anchoredEvent = resolveEvent(ctx, textual.event_id, 'ANCHOR_EVENT_NOT_FOUND');

      const authored = authoringSlot(anchoredEvent);
      if (authored === undefined) {
        throw refuse(
          'ANCHOR_SOURCE_NOT_ATTRIBUTABLE',
          `L'événement ${textual.event_id} ne porte aucune paternité d'expert : CCR ne fabrique pas ` +
            "l'attribution qui manque.",
          { event_id: textual.event_id },
        );
      }
      if (authored !== input.about_actor) {
        throw refuse(
          'ABOUT_ACTOR_MISMATCH',
          `La transcription se dit à propos de ${input.about_actor}, mais ${textual.event_id} a été produit ` +
            `par ${authored}.`,
          { event_id: textual.event_id, about_actor: input.about_actor, authoring_slot: authored },
        );
      }

      return {
        schema_version: CONTROVERSY_SCHEMA_VERSION,
        entry_id: ctx.allocateEntryId(),
        controversy_id: input.controversy_id,
        kind: 'ASSERTION_RECORDED',
        // L'origine est posée ici, jamais reçue : c'est ce qui rend le chemin
        // `SOURCE` structurellement inaccessible.
        semantic_origin: { kind: 'HUMAN', about_actor: input.about_actor },
        recorded_by: 'HUMAN',
        recorded_at: ctx.recordedAt,
        round: ctx.round,
        anchors: {
          provenance: [provenanceFromEvent(anchoredEvent)],
          textual,
          // Au plus une unité sémantique, garantie par la forme.
          semantic: { text: input.statement, semantic_origin: { kind: 'HUMAN', about_actor: input.about_actor } },
        },
        ...(input.note === undefined ? {} : { content: input.note }),
      };
    },
    boundary,
  );
}

// --------------------------------------------------------------------------
// 3. Enregistrer une assertion
// --------------------------------------------------------------------------

/**
 * Enregistre une assertion humaine rattachée à une controverse.
 *
 * Au plus une unité sémantique, portée par la forme. Aucun objet `Position`
 * n'est créé : deux assertions voisines restent deux assertions, et leur
 * continuité éventuelle s'exprime par une relation déclarée.
 *
 * Cette opération ne porte pas `about_actor`. Attribuer une sémantique à une
 * source relève de la transcription, qui exige un ancrage textuel.
 */
export async function recordAssertion(
  deps: ControversyServiceDeps,
  input: RecordAssertionInput,
  boundary?: NativeMutationBoundary,
): Promise<ControversyMutationResult> {
  return runControversyMutation(
    deps,
    input.runId,
    'v3-record-assertion',
    input.expected_controversy_revision,
    (ctx) => {
      requireBounded(input.statement, 'statement');
      if (input.note !== undefined) requireBounded(input.note, 'note');
      requireRecordedControversy(ctx, input.controversy_id);
      const provenance = buildProvenance(ctx, input.provenance_event_ids);

      return {
        schema_version: CONTROVERSY_SCHEMA_VERSION,
        entry_id: ctx.allocateEntryId(),
        controversy_id: input.controversy_id,
        kind: 'ASSERTION_RECORDED',
        semantic_origin: { kind: 'HUMAN' },
        recorded_by: 'HUMAN',
        recorded_at: ctx.recordedAt,
        round: ctx.round,
        anchors: {
          provenance,
          ...(input.textual_anchor === undefined
            ? {}
            : { textual: resolveTextualAnchor(ctx, input.textual_anchor) }),
          semantic: { text: input.statement, semantic_origin: { kind: 'HUMAN' } },
        },
        ...(input.note === undefined ? {} : { content: input.note }),
      };
    },
    boundary,
  );
}

// --------------------------------------------------------------------------
// 4. Déclarer une relation
// --------------------------------------------------------------------------

/** Types qui ne sont pas des unités sémantiques, donc jamais extrémités de relation. */
const RELATION_FORBIDDEN_ENDPOINT_KINDS: readonly ControversyEntryKind[] = [
  'NATURE_RECORDED',
  'HUMAN_AUTHORITY_RECORDED',
];

/**
 * Déclare une relation attribuée entre deux entrées de la même controverse.
 *
 * Validations **structurelles et déterministes**, et elles seules :
 *
 * ```text
 * EXIGÉ    les deux extrémités existent et appartiennent à la controverse
 *          l'acte appartient à { CONTESTS, REFORMULATES, WITHDRAWS }
 *          REFORMULATES et WITHDRAWS visent une entrée d'assertion
 *
 * REFUSÉ   relation inter-controverses · auto-référence
 *          extrémité NATURE_RECORDED ou HUMAN_AUTHORITY_RECORDED
 *
 * JAMAIS   « ces deux textes disent la même chose » · similarité
 *          « même position » · contradiction réelle · qualité
 * ```
 *
 * Aucune interdiction globale de cycle : `CONTESTS` peut légitimement être
 * réciproque, et un interdit général exigerait une analyse de l'acte que rien
 * n'autorise. Une relation est un **fait attribué**, pas une conclusion.
 */
export async function recordRelation(
  deps: ControversyServiceDeps,
  input: RecordRelationInput,
  boundary?: NativeMutationBoundary,
): Promise<ControversyMutationResult> {
  return runControversyMutation(
    deps,
    input.runId,
    'v3-record-relation',
    input.expected_controversy_revision,
    (ctx) => {
      if (input.note !== undefined) requireBounded(input.note, 'note');
      requireRecordedControversy(ctx, input.controversy_id);
      const provenance = buildProvenance(ctx, input.provenance_event_ids);

      if (input.from_entry_id === input.to_entry_id) {
        throw refuse('RELATION_SELF_REFERENCE', 'Une relation ne peut pas viser sa propre origine.', {
          entry_id: input.from_entry_id,
        });
      }

      const from = requireEntryInControversy(ctx, input.from_entry_id, input.controversy_id);
      const to = requireEntryInControversy(ctx, input.to_entry_id, input.controversy_id);

      for (const [role, endpoint] of [
        ['from', from],
        ['to', to],
      ] as const) {
        if (RELATION_FORBIDDEN_ENDPOINT_KINDS.includes(endpoint.kind)) {
          throw refuse(
            'RELATION_ENDPOINT_KIND_FORBIDDEN',
            `${endpoint.kind} n'est pas une unité sémantique contestable : elle ne peut pas être ` +
              `l'extrémité ${role} d'une relation.`,
            { role, entry_id: endpoint.entry_id, kind: endpoint.kind },
          );
        }
      }

      // Contrainte référentielle démontrable, et rien de plus : reformuler ou
      // retirer vise une assertion. Aucune contrainte temporelle n'est ajoutée
      // sans nécessité structurelle.
      if ((input.act === 'REFORMULATES' || input.act === 'WITHDRAWS') && to.kind !== 'ASSERTION_RECORDED') {
        throw refuse(
          'RELATION_TARGET_NOT_ASSERTION',
          `${input.act} vise une entrée d'assertion ; ${to.entry_id} est de type ${to.kind}.`,
          { act: input.act, entry_id: to.entry_id, kind: to.kind },
        );
      }

      return {
        schema_version: CONTROVERSY_SCHEMA_VERSION,
        entry_id: ctx.allocateEntryId(),
        controversy_id: input.controversy_id,
        kind: 'RELATION_RECORDED',
        semantic_origin: { kind: 'HUMAN' },
        recorded_by: 'HUMAN',
        recorded_at: ctx.recordedAt,
        round: ctx.round,
        anchors: { provenance },
        // L'acte est porté, jamais déduit de l'ancrage : un ancrage dit où et
        // sur quoi, jamais ce que l'entrée fait.
        relation: { from_entry_id: input.from_entry_id, to_entry_id: input.to_entry_id, act: input.act },
        ...(input.note === undefined ? {} : { content: input.note }),
      };
    },
    boundary,
  );
}

// --------------------------------------------------------------------------
// 5. Enregistrer une nature — `A9`
// --------------------------------------------------------------------------

/**
 * Enregistre une qualification de nature, facultative et attribuée.
 *
 * `A9` est fermé sur le principe ; le **vocabulaire** reste ouvert. Aucune
 * énumération fermée n'est imposée, aucun score n'est calculé, et la
 * qualification ne déclenche aucune conséquence automatique. Elle n'est pas un
 * champ de la controverse : c'est une entrée, comme les autres.
 */
export async function recordNature(
  deps: ControversyServiceDeps,
  input: RecordNatureInput,
  boundary?: NativeMutationBoundary,
): Promise<ControversyMutationResult> {
  return runControversyMutation(
    deps,
    input.runId,
    'v3-record-nature',
    input.expected_controversy_revision,
    (ctx) => {
      requireBounded(input.nature, 'nature');
      requireRecordedControversy(ctx, input.controversy_id);
      const provenance = buildProvenance(ctx, input.provenance_event_ids);

      return {
        schema_version: CONTROVERSY_SCHEMA_VERSION,
        entry_id: ctx.allocateEntryId(),
        controversy_id: input.controversy_id,
        kind: 'NATURE_RECORDED',
        semantic_origin: { kind: 'HUMAN' },
        recorded_by: 'HUMAN',
        recorded_at: ctx.recordedAt,
        round: ctx.round,
        anchors: { provenance },
        content: input.nature,
      };
    },
    boundary,
  );
}

// --------------------------------------------------------------------------
// 6. Enregistrer une autorité humaine
// --------------------------------------------------------------------------

/**
 * Enregistre un arbitrage humain, avec son périmètre énoncé.
 *
 * Strictement **V3 et controversy-scoped**. Ce n'est ni une décision de run, ni
 * une décision produit générale, ni la future `CcrDecision` native : la lacune
 * générale reste ouverte, et `decisions.jsonl` n'est pas réveillé. Prétendre
 * combler cette lacune ici créerait deux sources de vérité sur les décisions
 * humaines.
 *
 * Une cible structurée, lorsqu'elle est fournie, doit appartenir au domaine de
 * la controverse concernée.
 */
export async function recordHumanAuthority(
  deps: ControversyServiceDeps,
  input: RecordHumanAuthorityInput,
  boundary?: NativeMutationBoundary,
): Promise<ControversyMutationResult> {
  return runControversyMutation(
    deps,
    input.runId,
    'v3-record-human-authority',
    input.expected_controversy_revision,
    (ctx) => {
      requireBounded(input.scope, 'scope');
      if (input.content !== undefined) requireBounded(input.content, 'content');
      requireRecordedControversy(ctx, input.controversy_id);
      const provenance = buildProvenance(ctx, input.provenance_event_ids);

      if (input.target_entry_id !== undefined) {
        requireEntryInControversy(ctx, input.target_entry_id, input.controversy_id);
      }

      return {
        schema_version: CONTROVERSY_SCHEMA_VERSION,
        entry_id: ctx.allocateEntryId(),
        controversy_id: input.controversy_id,
        kind: 'HUMAN_AUTHORITY_RECORDED',
        semantic_origin: { kind: 'HUMAN' },
        recorded_by: 'HUMAN',
        recorded_at: ctx.recordedAt,
        round: ctx.round,
        anchors: { provenance },
        authority: {
          act: 'ARBITRATION',
          ...(input.target_entry_id === undefined ? {} : { target_entry_id: input.target_entry_id }),
          scope: input.scope,
        },
        ...(input.content === undefined ? {} : { content: input.content }),
      };
    },
    boundary,
  );
}

// --------------------------------------------------------------------------
// 7 et 8. Réponse humaine à une inférence CCR
// --------------------------------------------------------------------------

/**
 * Cible admissible d'une réponse humaine, et elle seule.
 *
 * ```text
 * ADMIS    une entrée de RELATION dont l'origine sémantique est CCR
 *          et qui porte une dérivation
 *
 * REFUSÉ   transcription HUMAN · relation HUMAN · assertion CCR non-relation
 *          NATURE_RECORDED · HUMAN_AUTHORITY_RECORDED · CONTROVERSY_RECORDED
 * ```
 *
 * L'inférence visée n'est **jamais** modifiée : la réponse est une nouvelle
 * entrée qui s'y réfère. Une contestation n'est pas une suppression
 * rétroactive, et une confirmation n'est pas une vérité sur le fond.
 */
function resolveInferenceTarget(ctx: MutationContext, entryId: string, controversyId: string): ControversyEntry {
  const target = requireEntryInControversy(ctx, entryId, controversyId);
  const isCcrRelationInference =
    target.kind === 'RELATION_RECORDED' &&
    target.semantic_origin.kind === 'CCR' &&
    target.derivation !== undefined;

  if (!isCcrRelationInference) {
    throw refuse(
      'AUTHORITY_TARGET_NOT_CCR_RELATION',
      `L'entrée ${entryId} n'est pas une inférence de relation produite par CCR : une réponse humaine ` +
        'ne peut pas la viser.',
      {
        entry_id: entryId,
        kind: target.kind,
        semantic_origin_kind: target.semantic_origin.kind,
        has_derivation: target.derivation !== undefined,
      },
    );
  }
  return target;
}

function respondToInferredRelation(
  deps: ControversyServiceDeps,
  input: RespondToInferredRelationInput,
  act: 'CONFIRM_RELATION' | 'CONTEST_RELATION',
  command: string,
  boundary?: NativeMutationBoundary,
): Promise<ControversyMutationResult> {
  return runControversyMutation(
    deps,
    input.runId,
    command,
    input.expected_controversy_revision,
    (ctx) => {
      if (input.content !== undefined) requireBounded(input.content, 'content');
      requireRecordedControversy(ctx, input.controversy_id);
      const provenance = buildProvenance(ctx, input.provenance_event_ids);
      resolveInferenceTarget(ctx, input.target_entry_id, input.controversy_id);

      return {
        schema_version: CONTROVERSY_SCHEMA_VERSION,
        entry_id: ctx.allocateEntryId(),
        controversy_id: input.controversy_id,
        kind: 'HUMAN_AUTHORITY_RECORDED',
        semantic_origin: { kind: 'HUMAN' },
        recorded_by: 'HUMAN',
        recorded_at: ctx.recordedAt,
        round: ctx.round,
        anchors: { provenance },
        // L'acte est server-authoritative : les deux valeurs sont strictement
        // symétriques et ne portent aucun champ de vérité.
        authority: { act, target_entry_id: input.target_entry_id },
        ...(input.content === undefined ? {} : { content: input.content }),
      };
    },
    boundary,
  );
}

/**
 * Confirme une relation inférée par CCR — `CONFIRM_RELATION`.
 *
 * `HUMAN CONFIRMATION ≠ TRUTH ON THE MERITS`. La lecture pourra dire qu'une
 * confirmation est enregistrée ; jamais qu'une position est vraie, qu'un expert
 * a raison, qu'il existe une convergence ou que la controverse est close.
 *
 * Une confirmation qui suit une contestation — ou une seconde confirmation —
 * est admise : deux gestes humains distincts sont deux faits historiques, et
 * aucune dernière réponse ne devient un état de vérité.
 */
export async function confirmInferredRelation(
  deps: ControversyServiceDeps,
  input: RespondToInferredRelationInput,
  boundary?: NativeMutationBoundary,
): Promise<ControversyMutationResult> {
  return respondToInferredRelation(deps, input, 'CONFIRM_RELATION', 'v3-confirm-relation', boundary);
}

/**
 * Conteste une relation inférée par CCR — `CONTEST_RELATION`.
 *
 * `HUMAN CONTESTATION ≠ RETROACTIVE DELETION`. L'inférence demeure dans
 * l'histoire avec son origine : la contestation ne dit pas qu'elle n'a jamais
 * existé, ni que CCR ne l'a jamais produite, ni qu'elle est fausse sur le fond.
 */
export async function contestInferredRelation(
  deps: ControversyServiceDeps,
  input: RespondToInferredRelationInput,
  boundary?: NativeMutationBoundary,
): Promise<ControversyMutationResult> {
  return respondToInferredRelation(deps, input, 'CONTEST_RELATION', 'v3-contest-relation', boundary);
}

// --------------------------------------------------------------------------
// Persistance d'une détection assistée par modèle — couture INTERNE
// --------------------------------------------------------------------------

/**
 * Une relation proposée par une détection, telle que le parseur S7-A la rend.
 *
 * Décrite structurellement plutôt qu'importée du détecteur : ce module est
 * l'autorité de persistance, et il ne dépend pas de ce qui l'appelle — c'est
 * l'inverse.
 */
export interface DetectedRelationProposal {
  readonly controversy_id: string;
  readonly from_entry_id: string;
  readonly to_entry_id: string;
  readonly act: RelationAct;
}

export interface RecordDetectedRelationsInput {
  readonly runId: string;
  /** Invocation réellement engagée. Jamais fabriquée, jamais optionnelle. */
  readonly invocation_id: string;
  /**
   * Périmètre de la dépêche : la controverse effectivement soumise.
   *
   * Le modèle ne choisit pas ce qu'il analyse. Une proposition qui nomme une
   * autre controverse du run est refusée, fût-elle structurellement valide
   * là-bas.
   */
  readonly controversy_id: string;
  /**
   * Références stables des éléments **effectivement soumis** au modèle,
   * capturées en phase A.
   *
   * Cette liste sert deux fois, et c'est délibéré : elle borne les extrémités
   * admissibles et elle remplit `derivation.inputs`. Une seule source, donc une
   * seule vérité — deux listes calculées séparément finiraient par diverger.
   */
  readonly inputs: readonly string[];
  readonly proposals: readonly DetectedRelationProposal[];
}

export interface RecordDetectedRelationsResult {
  readonly entries: readonly ControversyEntry[];
  readonly controversy_revision: string;
}

/**
 * Persiste les relations inférées par une détection gouvernée.
 *
 * **Couture interne, et elle le reste.** Elle n'est exposée à aucune des huit
 * opérations métier ni à aucun DTO HTTP, et n'accepte aucune charge générique.
 * Un appelant ne peut déclarer ni origine sémantique, ni acteur
 * d'enregistrement, ni méthode de dérivation, ni identité d'entrée : ces champs
 * sont posés ici. Seule l'orchestration de dispatch peut fournir un
 * `invocation_id`, parce qu'elle seule vient de l'engager.
 *
 * ## Aucun jeton de fraîcheur, et pourquoi
 *
 * Les huit opérations humaines comparent `expected_controversy_revision` parce
 * qu'un humain décide sur une vue antérieure au verrou. Ici, aucune vue
 * antérieure n'est invoquée : les propositions sont **revalidées contre les
 * faits courants** lus dans ce verrou, et la révision rendue est celle du
 * snapshot obtenu à l'instant. Exiger la révision du moment du dispatch ferait
 * échouer toute détection qu'une écriture humaine concurrente aurait croisée,
 * alors même que les entrées visées restent parfaitement valides — le journal
 * étant append-only, un identifiant d'entrée ne disparaît pas.
 *
 * ## Tout valider, puis seulement écrire
 *
 * Une seule proposition irrecevable, et le lot entier est refusé sans qu'aucun
 * octet n'ait été écrit. C'est ce qui évite de découvrir un conflit après un
 * premier append.
 *
 * Limite énoncée plutôt que masquée : le journal V3 n'a pas de primitive
 * d'écriture multi-lignes atomique, et n'en reçoit pas une ici. Une
 * interruption pendant la série d'appends laisse donc un préfixe — des lignes
 * complètes et valides, chacune portant son `invocation_id`. C'est le
 * comportement normal d'un journal append-only, et il reste auditable.
 */
export async function recordDetectedRelations(
  deps: ControversyServiceDeps,
  input: RecordDetectedRelationsInput,
  boundary?: NativeMutationBoundary,
): Promise<RecordDetectedRelationsResult> {
  const paths = runPaths(deps.runsDir, input.runId);
  if (typeof input.invocation_id !== 'string' || input.invocation_id.length === 0) {
    throw refuse('PROVENANCE_REQUIRED', "Une inference assistee par modele exige l'invocation qui l'a produite.");
  }

  return withNativeMutation(
    {
      runsDir: deps.runsDir,
      runId: input.runId,
      command: 'v3-record-detected-relations',
      ...(boundary === undefined ? {} : { boundary }),
    },
    async () => {
      // Relecture canonique : les faits du moment du dispatch ne sont jamais
      // réutilisés comme s'ils étaient courants.
      const snapshot = await readStableNativeRunSnapshot(deps.runsDir, input.runId);
      const ctx = buildMutationContext(snapshot, deps.now().toISOString());

      const derivation: Derivation = {
        method: 'MODEL_ASSISTED',
        invocation_id: input.invocation_id,
        inputs: [...input.inputs],
      };

      const candidates: ControversyEntry[] = [];
      const batchKeys = new Set<string>();

      for (let index = 0; index < input.proposals.length; index += 1) {
        const proposal = input.proposals[index] as DetectedRelationProposal;
        const at = `proposals[${String(index)}]`;

        // ---- Provenance : la proposition doit porter sur ce qui a réellement
        // été soumis. Ce contrôle précède les validations canoniques, parce
        // qu'il ne dépend pas de l'état courant : il compare la proposition au
        // périmètre et aux faits de la phase A.
        //
        // Sans lui, une relation pourrait être persistée avec une dérivation
        // affirmant des entrées que le modèle n'a jamais vues — une provenance
        // mensongère, que la validation canonique seule ne détecte pas.
        if (proposal.controversy_id !== input.controversy_id) {
          throw refuse(
            'DETECTION_SCOPE_MISMATCH',
            `${at} : la detection portait sur ${input.controversy_id}, la proposition nomme ` +
              `${proposal.controversy_id}. Le modele ne choisit pas son perimetre.`,
            { controversy_id: proposal.controversy_id, dispatch_scope: input.controversy_id },
          );
        }
        for (const [role, endpointId] of [
          ['from', proposal.from_entry_id],
          ['to', proposal.to_entry_id],
        ] as const) {
          if (!input.inputs.includes(endpointId)) {
            // Une entrée ajoutée pendant l'appel existe et appartient peut-être
            // à la controverse — mais elle n'a pas été soumise. La relecture
            // canonique ne doit pas la promouvoir en entrée rétroactive.
            throw refuse(
              'DETECTION_ENDPOINT_NOT_SUBMITTED',
              `${at} : ${endpointId} n'a pas ete soumis au modele ; il ne peut pas etre ` +
                `l'extremite ${role} d'une relation qu'il aurait inferee.`,
              { role, entry_id: endpointId },
            );
          }
        }

        // ---- Validations canoniques : exactement celles des relations
        // humaines, les mêmes fonctions, pas une seconde formulation.
        // L'origine du geste ne relâche rien.
        requireRecordedControversy(ctx, proposal.controversy_id);

        if (proposal.from_entry_id === proposal.to_entry_id) {
          throw refuse('RELATION_SELF_REFERENCE', `${at} : une relation ne peut pas viser sa propre origine.`, {
            entry_id: proposal.from_entry_id,
          });
        }

        const from = requireEntryInControversy(ctx, proposal.from_entry_id, proposal.controversy_id);
        const to = requireEntryInControversy(ctx, proposal.to_entry_id, proposal.controversy_id);

        for (const [role, endpoint] of [
          ['from', from],
          ['to', to],
        ] as const) {
          if (RELATION_FORBIDDEN_ENDPOINT_KINDS.includes(endpoint.kind)) {
            throw refuse(
              'RELATION_ENDPOINT_KIND_FORBIDDEN',
              `${at} : ${endpoint.kind} ne peut pas etre l'extremite ${role} d'une relation.`,
              { role, entry_id: endpoint.entry_id, kind: endpoint.kind },
            );
          }
        }

        if ((proposal.act === 'REFORMULATES' || proposal.act === 'WITHDRAWS') && to.kind !== 'ASSERTION_RECORDED') {
          throw refuse(
            'RELATION_TARGET_NOT_ASSERTION',
            `${at} : ${proposal.act} vise une entree d'assertion ; ${to.entry_id} est de type ${to.kind}.`,
            { act: proposal.act, entry_id: to.entry_id, kind: to.kind },
          );
        }

        const candidate = validateControversyEntry({
          schema_version: CONTROVERSY_SCHEMA_VERSION,
          entry_id: ctx.allocateEntryId(),
          controversy_id: proposal.controversy_id,
          kind: 'RELATION_RECORDED',
          // Origine et acteur posés ici, jamais reçus : c'est ce qui rend
          // impossible qu'un appelant se déclare lui-même CCR.
          semantic_origin: { kind: 'CCR' },
          recorded_by: 'CCR',
          recorded_at: ctx.recordedAt,
          round: ctx.round,
          anchors: { provenance: buildProvenance(ctx, provenanceEventIdsOf(from, to)) },
          derivation,
          relation: {
            from_entry_id: proposal.from_entry_id,
            to_entry_id: proposal.to_entry_id,
            act: proposal.act,
          },
        });

        // Doublon exact du contrat — contre le journal ET contre le lot en
        // cours. Découvrir la seconde moitié d'un doublon après avoir écrit la
        // première serait exactement ce que la validation préalable évite.
        const key = exactDuplicateKey(candidate);
        if (ctx.entries.some((entry) => exactDuplicateKey(entry) === key) || batchKeys.has(key)) {
          throw refuse('EXACT_DUPLICATE', `${at} : cette relation existe deja a l'identique.`, {
            controversy_id: candidate.controversy_id,
            kind: candidate.kind,
          });
        }
        batchKeys.add(key);
        candidates.push(candidate);
      }

      // Toutes validées : seulement maintenant, on écrit.
      const written: ControversyEntry[] = [];
      for (const candidate of candidates) written.push(await appendControversyEntry(paths, candidate));

      const after = await readControversyJournal(paths);
      return { entries: written, controversy_revision: after.revision };
    },
  );
}

/**
 * Provenance d'une relation inférée : celle des deux entrées reliées.
 *
 * Recopiée de leurs ancrages existants plutôt que reçue — le modèle n'a aucune
 * autorité sur la provenance, et CCR la connaît déjà.
 */
function provenanceEventIdsOf(from: ControversyEntry, to: ControversyEntry): readonly string[] {
  const ids: string[] = [];
  for (const entry of [from, to]) {
    for (const anchor of entry.anchors.provenance) {
      if (!ids.includes(anchor.event_id)) ids.push(anchor.event_id);
    }
  }
  return ids;
}
