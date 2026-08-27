/**
 * Service métier V4 — les deux mutations humaines de l'Evidence Engine.
 *
 * Tranche S4 du plan gelé. Ce module est l'**autorité unique** de l'écriture
 * V4 : il établit les faits canoniques sous la frontière de mutation native
 * gelée, alloue les identités depuis l'état autoritaire, et délègue toute
 * mécanique de journal au store de S2.
 *
 * ```text
 * verrou de run  →  snapshot stable  →  fraîcheur V4  →  validation
 *                →  champs serveur   →  append        →  révision résultante
 * ```
 *
 * ## Zéro fournisseur, prouvé par le type
 *
 * `EvidenceServiceDeps` ne porte **aucune** fabrique d'adaptateur. Ce n'est pas
 * une omission : c'est la preuve, au niveau du type, qu'aucun fournisseur ne
 * peut être invoqué depuis ce module. Aucun ledger, aucun quota, aucun
 * `invocation_id` n'y est produit non plus.
 *
 * ## Enregistrer n'est pas adduire
 *
 * ```text
 * registerMaterial   CCR détient/identifie un objet — et rien d'autre
 * adduceMaterial     un humain le verse au débat, à propos d'une cible
 * ```
 *
 * Enregistrer un matériau ne produit **jamais** d'adduction, ni automatiquement,
 * ni sur option. C'est le finding central rendu opérationnel, et une garde le
 * vérifie plutôt que de s'en remettre à la discipline des appelants.
 *
 * ## Ce que ce module n'affirme jamais
 *
 * Il enregistre qu'un acteur a versé un matériau avec une orientation déclarée.
 * Il ne dit ni que la cible est vraie, ni qu'elle est fausse, ni que le matériau
 * est fiable, suffisant ou probant. Aucune force, aucun score, aucun classement,
 * aucun cycle de vie.
 */

import {
  EVIDENCE_SCHEMA_VERSION,
  formatAdductionId,
  formatMaterialId,
  isControversyEntryTargetId,
  isMaterialId,
  materialIsHeld,
  parseAdductionSequence,
  parseMaterialSequence,
  validateEvidenceEntry,
} from '../core/evidence.ts';
import type {
  AdductionCitation,
  AdductionRecordedEntry,
  EvidenceEntry,
  MaterialRecordedEntry,
  MaterialRepresentation,
  Orientation,
} from '../core/evidence.ts';
import { CcrError } from '../core/errors.ts';
import type { NativeCcrEvent } from '../core/run-native.ts';
import { runPaths } from '../store/layout.ts';
import { appendEvidenceEntries, readEvidenceJournal } from '../store/evidence-store.ts';
import { readStableNativeRunSnapshot } from '../store/native-run-snapshot.ts';
import type { NativeRunSnapshot } from '../store/native-run-snapshot.ts';
import { withNativeMutation } from './native-mutation-boundary.ts';
import type { NativeMutationBoundary } from './native-mutation-boundary.ts';

/**
 * Effet fournisseur des deux opérations de ce module.
 *
 * Constante et non calculée : elle est vraie par construction, puisqu'aucun
 * adaptateur n'est atteignable depuis ici.
 */
export const EVIDENCE_HUMAN_PROVIDER_EFFECT = 'EXACT(0)' as const;

// --------------------------------------------------------------------------
// Refus
// --------------------------------------------------------------------------

/**
 * Motifs de refus métier V4 — union fermée.
 *
 * Aucun motif d'assistance modèle n'y figure : S4 ne peut produire aucune
 * adduction inférée, et n'a donc rien à refuser de ce côté.
 */
export const EVIDENCE_REFUSAL_REASONS = [
  'RUN_EVENT_NOT_FOUND',
  'MATERIAL_NOT_FOUND',
  'TARGET_NOT_FOUND',
  'CITATION_MATERIAL_NOT_HELD',
  'CITATION_CONTENT_UNAVAILABLE',
  'CITATION_OCCURRENCE_NOT_FOUND',
] as const;
export type EvidenceRefusalReason = (typeof EVIDENCE_REFUSAL_REASONS)[number];

function refuse(
  reason: EvidenceRefusalReason,
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
 * L'absence de `createAdapters` est la preuve, au niveau du type, qu'aucun
 * fournisseur ne peut être invoqué depuis ce module.
 */
export interface EvidenceServiceDeps {
  readonly runsDir: string;
  now(): Date;
}

interface RunScopedInput {
  readonly runId: string;
  /**
   * Jeton de fraîcheur du **domaine V4**, obtenu d'un snapshot stable.
   *
   * Jamais fabriqué par un client, et jamais confondu avec la révision du run
   * ni avec celle des controverses : un tour d'expert ne périme pas une
   * adduction, et une adduction ne périme pas le run.
   */
  readonly expected_evidence_revision: string;
}

/**
 * Représentation telle que l'appelant la soumet.
 *
 * Exactement les trois formes du contrat. `observed_by_ccr` n'y figure pas :
 * il suit la forme, et le serveur le pose.
 */
export type MaterialRepresentationInput =
  | { readonly form: 'RUN_EVENT'; readonly event_id: string }
  | { readonly form: 'INLINE_TEXT'; readonly text: string }
  | {
      readonly form: 'EXTERNAL_REFERENCE';
      readonly locator: string;
      /** Déclarée par l'appelant. Jamais calculée, jamais vérifiée, jamais promue. */
      readonly declared_digest?: string;
    };

export interface RegisterMaterialInput extends RunScopedInput {
  readonly representation: MaterialRepresentationInput;
  /** Texte libre borné destiné à l'humain. Jamais une catégorie. */
  readonly label?: string;
}

/**
 * Adduction humaine.
 *
 * Aucun `semantic_origin` n'est reçu : l'origine est `HUMAN`, et il n'existe
 * dans ce module aucun chemin qui produise `CCR`. Aucune `derivation` n'est
 * reçue non plus — la construire exigerait une invocation gouvernée, qui
 * n'appartient pas à cette tranche.
 *
 * La sorte de cible n'est pas reçue : une seule est admise, et laisser
 * l'appelant la nommer lui permettrait de désigner une sorte future que le
 * contrat n'a pas ouverte.
 */
export interface AdduceMaterialInput extends RunScopedInput {
  readonly material_id: string;
  readonly target_entry_id: string;
  /** Fournie explicitement. Le service n'applique **aucun** défaut. */
  readonly orientation: Orientation;
  readonly citation?: AdductionCitation;
}

export interface EvidenceMutationResult {
  readonly runId: string;
  readonly entry: EvidenceEntry;
  /** Révision de la source **après** l'append, calculée sous le même verrou. */
  readonly evidence_revision: string;
  readonly provider_effect: typeof EVIDENCE_HUMAN_PROVIDER_EFFECT;
}

// --------------------------------------------------------------------------
// Contexte de mutation
// --------------------------------------------------------------------------

interface MutationContext {
  readonly snapshot: NativeRunSnapshot;
  readonly events: ReadonlyMap<string, NativeCcrEvent>;
  readonly materialsById: ReadonlyMap<string, MaterialRecordedEntry>;
  readonly controversyEntryIds: ReadonlySet<string>;
  readonly recordedAt: string;
  allocateMaterialId(): string;
  allocateAdductionId(): string;
}

/**
 * Établit le contexte d'une mutation depuis un snapshot déjà lu **sous verrou**.
 *
 * Les deux séquences sont allouées depuis l'état autoritaire, séparément :
 * aucun compteur persistant parallèle n'existe, et aucune collision n'est
 * possible tant que le verrou couvre la lecture et l'append.
 */
function buildMutationContext(snapshot: NativeRunSnapshot, recordedAt: string): MutationContext {
  const events = new Map<string, NativeCcrEvent>();
  for (const event of snapshot.events) events.set(event.event_id, event);

  const controversyEntryIds = new Set<string>();
  for (const entry of snapshot.controversies) controversyEntryIds.add(entry.entry_id);

  const materialsById = new Map<string, MaterialRecordedEntry>();
  let maxMaterial = 0;
  let maxAdduction = 0;
  for (const entry of snapshot.evidence) {
    if (entry.kind === 'MATERIAL_RECORDED') {
      materialsById.set(entry.entry_id, entry);
      maxMaterial = Math.max(maxMaterial, parseMaterialSequence(entry.entry_id) ?? 0);
    } else {
      maxAdduction = Math.max(maxAdduction, parseAdductionSequence(entry.entry_id) ?? 0);
    }
  }

  let allocatedMaterials = 0;
  let allocatedAdductions = 0;

  return {
    snapshot,
    events,
    materialsById,
    controversyEntryIds,
    recordedAt,
    allocateMaterialId: (): string => {
      allocatedMaterials += 1;
      return formatMaterialId(maxMaterial + allocatedMaterials);
    },
    allocateAdductionId: (): string => {
      allocatedAdductions += 1;
      return formatAdductionId(maxAdduction + allocatedAdductions);
    },
  };
}

// --------------------------------------------------------------------------
// Résolution de citation
// --------------------------------------------------------------------------

/**
 * Occurrences exactes, **chevauchements compris**, rang 1-based.
 *
 * Même règle que la projection de lecture applique — la recherche reprend à
 * `start + 1`, jamais à `start + longueur`. Deux comptages différents
 * donneraient deux rangs pour la même citation, et l'écriture accepterait ce
 * que la lecture déclarerait non résolu.
 *
 * Réénoncée ici plutôt que partagée : la mutualiser exigerait de modifier un
 * module d'une tranche déjà acceptée. Le coût est une duplication de douze
 * lignes ; le prix de l'alternative serait de rouvrir S1 ou S3.
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
 * Confronte une citation à la représentation détenue du matériau visé.
 *
 * Le contrat exige les deux membres : le matériau doit être détenu, **et** le
 * texte doit apparaître au rang annoncé. Un succès établit exactement
 * `CITATION EXISTS IN MATERIAL` — jamais `CITATION SUPPORTS TARGET`.
 */
function assertCitationResolves(
  ctx: MutationContext,
  material: MaterialRecordedEntry,
  citation: AdductionCitation,
): void {
  const representation = material.representation;

  if (!materialIsHeld(representation.form)) {
    throw refuse(
      'CITATION_MATERIAL_NOT_HELD',
      `Une citation est impossible sur un matériau ${representation.form} : CCR n'en détient ` +
        "aucune représentation à confronter. Le refus porte sur la citation, jamais sur l'adduction.",
      { material_id: material.entry_id, form: representation.form },
    );
  }

  // Le discriminant du domaine est testé POSITIVEMENT sur les deux formes
  // détenues. `materialIsHeld` reste la garde métier — il décide du refus —
  // mais il rend un booléen, et un booléen ne rétrécit pas une union
  // discriminée : la branche `else` conservait `EXTERNAL_REFERENCE`, que la
  // garde avait pourtant déjà écartée. Rien du comportement ne change.
  let content: string;
  if (representation.form === 'INLINE_TEXT') {
    content = representation.text;
  } else if (representation.form === 'RUN_EVENT') {
    const event = ctx.events.get(representation.event_id);
    if (event === undefined || typeof event.content !== 'string') {
      throw refuse(
        'CITATION_CONTENT_UNAVAILABLE',
        `Le contenu du matériau ${material.entry_id} n'est pas disponible : la citation ne peut pas ` +
          'être confrontée.',
        { material_id: material.entry_id, event_id: representation.event_id },
      );
    }
    content = event.content;
  } else {
    // Inatteignable : la garde ci-dessus a déjà refusé cette forme. Elle rend
    // ici le MÊME refus, pour qu'aucun monde — même impossible — ne produise un
    // comportement que la garde n'aurait pas produit.
    throw refuse(
      'CITATION_MATERIAL_NOT_HELD',
      `Une citation est impossible sur un matériau ${representation.form} : CCR n'en détient ` +
        "aucune représentation à confronter. Le refus porte sur la citation, jamais sur l'adduction.",
      { material_id: material.entry_id, form: representation.form },
    );
  }

  if (!occurrenceExists(content, citation.quoted_text, citation.occurrence)) {
    throw refuse(
      'CITATION_OCCURRENCE_NOT_FOUND',
      `La citation ne se confronte pas au rang ${String(citation.occurrence)} du matériau ` +
        `${material.entry_id}.`,
      { material_id: material.entry_id, occurrence: citation.occurrence },
    );
  }
}

// --------------------------------------------------------------------------
// Frontière commune — verrou, fraîcheur, validation, append
// --------------------------------------------------------------------------

/**
 * Exécute une mutation métier V4 de bout en bout, sous **un seul** verrou.
 *
 * L'ordre est le contrat lui-même : la fraîcheur est comparée avant toute
 * validation métier, et toute validation précède l'unique écriture durable. Un
 * refus, quel qu'il soit, laisse le journal — et son absence — intacts.
 *
 * Le snapshot est la **seule** vue qui fait autorité pour la validation. La
 * relecture qu'effectue `appendEvidenceEntries` ne sert qu'à la normalisation
 * physique d'une queue non écrite, sous ce même verrou : aucune décision métier
 * n'en dépend, et aucune fenêtre ne s'ouvre entre les deux.
 */
async function runEvidenceMutation(
  deps: EvidenceServiceDeps,
  runId: string,
  command: string,
  expectedRevision: string,
  build: (ctx: MutationContext) => EvidenceEntry,
  boundary?: NativeMutationBoundary,
): Promise<EvidenceMutationResult> {
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
      // sur un journal corrompu ou de version inconnue, et rend la révision V4
      // calculée par la sémantique de S2 — jamais une variante locale.
      const snapshot = await readStableNativeRunSnapshot(deps.runsDir, runId);

      if (snapshot.evidence_revision !== expectedRevision) {
        // Avant toute validation métier et avant tout octet écrit : une vue
        // périmée invalide la demande entière, pas seulement sa cible.
        throw new CcrError(
          'STALE_REVISION',
          `L'Evidence Engine du run ${runId} a changé depuis la vue de l'appelant : aucune écriture ` +
            "n'est tentée.",
          {
            details: {
              runId,
              expected_evidence_revision: expectedRevision,
              actual_evidence_revision: snapshot.evidence_revision,
            },
          },
        );
      }

      const ctx = buildMutationContext(snapshot, deps.now().toISOString());
      const candidate = validateEvidenceEntry(build(ctx));

      // Unique écriture durable. `appendEvidenceEntries` relit, refuse toute
      // corruption terminée, normalise un fragment non écrit, puis ajoute une
      // ligne complète — le tout dans ce verrou, comme S2 l'exigeait.
      const written = await appendEvidenceEntries(paths, [candidate]);

      const after = await readEvidenceJournal(paths);
      return {
        runId,
        entry: written[0] as EvidenceEntry,
        evidence_revision: after.revision,
        provider_effect: EVIDENCE_HUMAN_PROVIDER_EFFECT,
      };
    },
  );
}

// --------------------------------------------------------------------------
// 1. Enregistrer un matériau
// --------------------------------------------------------------------------

/**
 * Construit la représentation canonique depuis la soumission de l'appelant.
 *
 * Le contenu n'est **jamais** transformé : aucune normalisation, aucun trim,
 * aucune analyse Markdown, aucune interprétation. Un localisateur externe n'est
 * ni résolu, ni ouvert, ni contacté — il reste une chaîne enregistrée.
 */
function buildRepresentation(
  ctx: MutationContext,
  input: MaterialRepresentationInput,
): MaterialRepresentation {
  switch (input.form) {
    case 'RUN_EVENT': {
      // Le contrat l'exige : un `event_id` inconnu est un refus déterministe.
      // Résolu depuis le snapshot déjà acquis, jamais par une seconde lecture.
      if (!ctx.events.has(input.event_id)) {
        throw refuse(
          'RUN_EVENT_NOT_FOUND',
          `L'événement ${input.event_id} n'existe pas dans ce run : aucun matériau n'est enregistré.`,
          { event_id: input.event_id },
        );
      }
      return { form: 'RUN_EVENT', event_id: input.event_id };
    }

    case 'INLINE_TEXT':
      return { form: 'INLINE_TEXT', text: input.text };

    case 'EXTERNAL_REFERENCE':
      return {
        form: 'EXTERNAL_REFERENCE',
        locator: input.locator,
        ...(input.declared_digest === undefined ? {} : { declared_digest: input.declared_digest }),
      };
  }
}

/**
 * Enregistre un matériau et lui donne une identité.
 *
 * L'identité est **épistémiquement neutre** : elle atteste qu'un enregistrement
 * existe dans ce run, jamais que deux matériaux sont le même objet dans le
 * monde. Deux soumissions de charge identique produisent donc deux
 * enregistrements distincts — CCR ne possède aucune autorité d'équivalence, et
 * aucune déduplication par contenu, par empreinte ou par localisateur n'existe.
 *
 * **Cette opération ne produit jamais d'adduction.** Enregistrer un matériau
 * dit que CCR le détient ou l'identifie, et rien de plus.
 */
export async function registerMaterial(
  deps: EvidenceServiceDeps,
  input: RegisterMaterialInput,
  boundary?: NativeMutationBoundary,
): Promise<EvidenceMutationResult> {
  return runEvidenceMutation(
    deps,
    input.runId,
    'v4-register-material',
    input.expected_evidence_revision,
    (ctx) => {
      const representation = buildRepresentation(ctx, input.representation);
      return {
        schema_version: EVIDENCE_SCHEMA_VERSION,
        entry_id: ctx.allocateMaterialId(),
        kind: 'MATERIAL_RECORDED',
        recorded_by: 'CCR',
        recorded_at: ctx.recordedAt,
        submitted_by: 'HUMAN',
        representation,
        // Suit la forme, jamais déclaré : une référence externe « observée »
        // décrirait une observation qui n'a pas eu lieu.
        observed_by_ccr: materialIsHeld(representation.form),
        ...(input.label === undefined ? {} : { label: input.label }),
      };
    },
    boundary,
  );
}

// --------------------------------------------------------------------------
// 2. Adduire un matériau — geste humain
// --------------------------------------------------------------------------

/**
 * Verse un matériau au débat, à propos d'une entrée de controverse.
 *
 * Le fait enregistré est exactement celui-ci :
 *
 * > cet acteur a adduit ce matériau — l'a versé au débat — à propos de cette
 * > cible, avec cette orientation argumentative, à cette date.
 *
 * Il ne dit **rien** sur qui a créé, écrit ou fourni le matériau : la provenance
 * du matériau et l'origine sémantique de l'adduction sont deux faits distincts.
 *
 * ```text
 * SUPPORTS    ≠  la cible est vraie
 * OBJECTS_TO  ≠  la cible est fausse
 * NONE        ≠  sans pertinence
 * ```
 *
 * Une adduction est un **acte historique** : deux gestes identiques produisent
 * deux faits, avec deux identités. Aucune déduplication n'existe, et la garde de
 * doublon exact de V3 n'est délibérément pas transposée — effacer le second
 * geste effacerait l'information qu'une personne a agi deux fois, ou que deux
 * personnes ont agi.
 *
 * Un matériau que CCR n'a pas observé reste parfaitement adductible : non
 * vérifiable ne signifie pas faux. Seule une **citation** y est impossible,
 * faute de représentation à confronter.
 */
export async function adduceMaterial(
  deps: EvidenceServiceDeps,
  input: AdduceMaterialInput,
  boundary?: NativeMutationBoundary,
): Promise<EvidenceMutationResult> {
  return runEvidenceMutation(
    deps,
    input.runId,
    'v4-adduce-material',
    input.expected_evidence_revision,
    (ctx) => {
      if (!isMaterialId(input.material_id)) {
        throw refuse('MATERIAL_NOT_FOUND', `material_id non canonique : ${String(input.material_id)}.`, {
          material_id: input.material_id,
        });
      }
      const material = ctx.materialsById.get(input.material_id);
      if (material === undefined) {
        throw refuse(
          'MATERIAL_NOT_FOUND',
          `Le matériau ${input.material_id} n'est pas enregistré dans ce run : une adduction référence ` +
            "un enregistrement existant, elle n'en crée aucun.",
          { material_id: input.material_id },
        );
      }

      // Une cible est une ENTRÉE — `ctv_` désigne une controverse, jamais une
      // cible. Résolue depuis le journal V3 du même snapshot, sans seconde
      // lecture, et sans qu'aucune donnée V3 ne soit touchée.
      if (!isControversyEntryTargetId(input.target_entry_id)) {
        throw refuse(
          'TARGET_NOT_FOUND',
          `target_entry_id non canonique : ${String(input.target_entry_id)}. Une cible est une entrée ` +
            "de controverse — `ctv_` n'en est jamais une.",
          { target_entry_id: input.target_entry_id },
        );
      }
      if (!ctx.controversyEntryIds.has(input.target_entry_id)) {
        throw refuse(
          'TARGET_NOT_FOUND',
          `L'entrée de controverse ${input.target_entry_id} n'existe pas dans ce run.`,
          { target_entry_id: input.target_entry_id },
        );
      }

      // Le contrat exige les deux membres : matériau détenu, et texte présent
      // au rang annoncé.
      if (input.citation !== undefined) assertCitationResolves(ctx, material, input.citation);

      return {
        schema_version: EVIDENCE_SCHEMA_VERSION,
        entry_id: ctx.allocateAdductionId(),
        kind: 'ADDUCTION_RECORDED',
        recorded_by: 'CCR',
        recorded_at: ctx.recordedAt,
        material_id: input.material_id,
        // La sorte est posée par le serveur : une seule est admise, et laisser
        // l'appelant la nommer lui permettrait de désigner une sorte future.
        target: { kind: 'CONTROVERSY_ENTRY', entry_id: input.target_entry_id },
        // Reprise telle quelle. Aucun défaut, aucune reconstruction : S1 refuse
        // une valeur absente ou inconnue.
        orientation: input.orientation,
        // Ce module ne produit que des adductions humaines. Aucune `derivation`
        // n'est construite, et aucune n'est reçue.
        semantic_origin: 'HUMAN',
        ...(input.citation === undefined ? {} : { citation: input.citation }),
      };
    },
    boundary,
  );
}
