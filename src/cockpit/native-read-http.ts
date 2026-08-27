/**
 * Lectures HTTP d'un run **natif V2.1** (V2.1-IMP-17B).
 *
 * ## Ce que cette couche fait, et rien d'autre
 *
 * ```text
 * charger  →  aiguiller  →  projeter  →  sérialiser
 * ```
 *
 * Aucune règle métier n'est réévaluée ici. La source d'un transfert, les alias
 * de fournisseur, les sessions, les quatre reprises, `pause`, `resume`, `send`,
 * `handoff` et la barrière de fraîcheur viennent tous de la projection 2D, qui
 * les tient elle-même des moteurs qui font autorité. Ce module ne contient pas
 * un seul `if` métier.
 *
 * ## Un seul instantané
 *
 * La révision et la vue proviennent du **même** snapshot stable. C'est le
 * critère central du slice : rendre une empreinte calculée sur des faits A et
 * une vue construite sur des faits B décrirait deux mondes, et la future
 * précondition `expected_revision` porterait sur celui que l'humain n'a pas vu.
 *
 * Aucun verrou n'est pris — un `GET` doit rester possible pendant qu'un HANDOFF
 * détient le run lock, parfois toute une intervention humaine durant.
 *
 * ## Ce que cette couche ne fait pas
 *
 * Elle n'écrit rien, n'ouvre aucune opération, ne touche ni `OperationStore` ni
 * `LongOperationManager`, et n'expose aucune mutation.
 *
 * ## Chronologie (V2.1-IMP-19)
 *
 * La chronologie native rejoint ces lectures, et sous la même règle : la page
 * rendue et la révision qui l'accompagne viennent du **même** instantané. La
 * pagination y est donc liée — une page suivante demandée sur une révision
 * périmée est refusée, jamais recousue avec une autre vue.
 */

import { CcrError } from '../core/errors.ts';
import { EXPERT_SLOT_IDS } from '../core/expert.ts';
import type { ExpertSlotId } from '../core/expert.ts';
import { readStableNativeRunSnapshot } from '../store/native-run-snapshot.ts';
import { projectNativeRunReadModelFromSnapshot } from '../services/native-read-model.ts';
import type { NativeRecoveryActionId, NativeRunReadModelV1 } from '../services/native-read-model.ts';
import { projectCockpitPresentation } from '../services/cockpit-presentation.ts';
import type { CockpitPresentationV1 } from '../services/cockpit-presentation.ts';
import { projectControversyReadModel } from '../services/controversy-read-model.ts';
import type { ControversyReadModelV1 } from '../services/controversy-read-model.ts';
import { projectEvidenceReadModel } from '../services/evidence-read-model.ts';
import type { EvidenceReadModelV1 } from '../services/evidence-read-model.ts';
import { projectReconciliationReadModel } from '../services/reconciliation-read-model.ts';
import type { ReconciliationReadModelV1 } from '../services/reconciliation-read-model.ts';
import {
  DEFAULT_TIMELINE_PAGE_SIZE,
  decodeTimelineCursor,
  encodeTimelineCursor,
} from '../services/cockpit-read-model.ts';
import {
  NATIVE_TIMELINE_VERSION,
  projectNativeTimeline,
} from '../services/native-timeline-read-model.ts';
import type { NativeTimelineEntryV1 } from '../services/native-timeline-read-model.ts';

export interface NativeReadHttpDeps {
  readonly runsDir: string;
  /**
   * Garde-fou de transfert du run appelant.
   *
   * Reçu, jamais résolu ici : c'est ce qui interdit que la taille projetée
   * diffère de celle qu'appliquera le service.
   */
  readonly maxTransferBytes?: number;
}

/**
 * Réponse d'un `GET` natif — enveloppe **discriminée**.
 *
 * `NativeRunReadModelV1` n'est pas forcé dans le `RunView` historique : ce
 * dernier est provider-keyed jusque dans ses clés — `sessions.claude`,
 * `active_agent` — et l'y couler exigerait exactement la traduction que V2.1
 * existe pour supprimer.
 */
export interface NativeRunHttpView {
  readonly generation: 'NATIVE_V21_EXECUTION';
  readonly revision: string;
  readonly run: NativeRunReadModelV1;
  /**
   * Faits de présentation (`V2.3-S1`) — **additifs**.
   *
   * Composés depuis le **même** snapshot que `run`, donc sous la même révision.
   * Aucun champ existant n'est modifié, et une vue historique n'en reçoit
   * jamais : `NATIVE_FIRST` reste gelé.
   */
  readonly presentation: CockpitPresentationV1;
  /**
   * Projection des controverses (`V3-S3`) — **additive**.
   *
   * Composée depuis le **même** snapshot que `run` et `presentation`, donc sous
   * la même révision, et sans aucune seconde lecture du journal V3. Une vue
   * historique n'en reçoit jamais : cette surface est native, et un run legacy
   * reçoit `NOT_AVAILABLE` par la projection dédiée, jamais un compteur à zéro.
   */
  readonly controversies: ControversyReadModelV1;
  /**
   * Jeton de fraîcheur du **domaine V3** (`V5.1`) — porté par l'enveloppe.
   *
   * La projection V3 ne le porte pas : ce n'est pas une omission, c'est son
   * contrat. Mais une surface de mutation V3 en a besoin comme précondition, et
   * jusqu'ici aucune lecture ne l'exposait — un navigateur ne pouvait donc pas
   * écrire, faute de pouvoir dire sur quelle vue il avait décidé.
   *
   * Il vient du **même** instantané que ses voisins, et reste dans son propre
   * espace : il ne se compare ni à `revision`, ni à `evidence_revision`, ni à
   * `reconciliation_revision`.
   *
   * Le §35 du contrat V3 nomme exactement cette extension — « HTTP : extension
   * additive des read models existants ».
   */
  readonly controversy_revision: string;
  /**
   * Projection de l'Evidence Engine (`V4-S3`) — **additive**.
   *
   * Composée depuis le **même** snapshot que les trois champs voisins, donc sous
   * la même fenêtre stable, et sans aucune seconde lecture du journal V4. Elle
   * porte sa propre fraîcheur, `evidence_revision`, distincte de `revision` :
   * une adduction ne périme pas le run, et un tour d'expert ne périme pas une
   * adduction.
   *
   * Une vue historique n'en reçoit jamais : cette surface est native, et un run
   * legacy reçoit `NOT_AVAILABLE` par la projection dédiée, jamais un compteur à
   * zéro.
   */
  readonly evidence: EvidenceReadModelV1;
  /**
   * Projection du moteur de réconciliation (`V5-S12`) — **additive**.
   *
   * Composée depuis le **même** snapshot que ses quatre voisines, donc sous la
   * même fenêtre stable, et sans aucune seconde lecture du journal V5. Elle
   * porte sa propre fraîcheur, `reconciliation_revision`, distincte des trois
   * autres : un acte de réconciliation ne périme ni le run, ni une controverse,
   * ni une adduction.
   *
   * C'est **une lecture, et seulement une lecture**. Le §40 du contrat V5 la
   * prévoit — « read model : exposé » — et le §43 la borne dans les mêmes mots :
   * « La lecture V5 est exposée par la projection additive, sans mutation. »
   * Aucune route de mutation V5 n'accompagne ce champ.
   *
   * `NOT_AVAILABLE` reste structurel : un run que V5 ne regarde pas n'a pas zéro
   * acte, et la forme le dit en ne portant aucun compteur.
   */
  readonly reconciliations: ReconciliationReadModelV1;
  /**
   * Ce qui est **réellement en vol**, à destination de l'affichage (`V5.1`).
   *
   * Le run réel `CCR-20260404-001` a duré dix-huit minutes en initialisation
   * sans qu'aucun écran ne dise qui travaillait ni depuis quand, alors que
   * `pending_operation` portait déjà le slot et l'horodatage de départ. Ce
   * champ ne découvre donc aucun fait : il rassemble ceux qui existaient et que
   * personne ne joignait.
   *
   * Il est calculé **ici**, et non dans le navigateur, pour une raison précise :
   * la position dans la séquence d'initialisation dépend de l'ordre canonique
   * des slots, qui est une règle du cœur. La déduire côté client la dupliquerait
   * — et une interface qui recalcule une règle finit par en inventer une.
   *
   * `null` quand rien n'est en vol. Jamais un objet vide, jamais une durée
   * estimée, jamais un pourcentage.
   */
  readonly in_flight: NativeInFlightV1 | null;
}

/**
 * Position dans une séquence **réellement connue**.
 *
 * N'existe que là où le cœur fixe l'ordre. Une séquence supposée n'en produit
 * pas : mieux vaut ne rien afficher qu'afficher « étape 1/2 » au hasard.
 */
export interface NativeSequencePositionV1 {
  readonly position: number;
  readonly total: number;
}

export interface NativeInFlightV1 {
  /** Nature de l'opération engagée, telle que l'état la nomme. */
  readonly kind: 'initialization' | 'send' | 'handoff' | 'step';
  /** Slot **appelé**. Pour un transfert, c'est la cible, jamais la source. */
  readonly expert_slot: ExpertSlotId;
  /** Moteur lié à ce slot dans le manifeste. Deux slots peuvent le partager. */
  readonly provider: string;
  /** Départ, tel que l'état l'a figé **avant** l'appel. */
  readonly started_at: string;
  /** Position, uniquement lorsque la séquence est déterminée par le cœur. */
  readonly sequence: NativeSequencePositionV1 | null;
}

/**
 * Joint `pending_operation` et le manifeste — sans réévaluer quoi que ce soit.
 *
 * L'initialisation est la seule séquence dont l'ordre soit fixé : le service de
 * création parcourt `EXPERT_SLOT_IDS`, et cet ordre est celui du cœur. Un
 * transfert, un envoi ou un handoff n'ont pas de position : ils ne le disent
 * donc pas.
 */
function projectInFlight(run: NativeRunReadModelV1): NativeInFlightV1 | null {
  const pending = run.operational_state.pending_operation;
  if (pending === null) return null;

  const slot: ExpertSlotId = pending.kind === 'step' ? pending.target_slot : pending.expert_slot;
  const expert = run.experts[slot];

  return {
    kind: pending.kind,
    expert_slot: slot,
    provider: expert.provider,
    started_at: pending.started_at,
    sequence:
      pending.kind === 'initialization'
        ? { position: EXPERT_SLOT_IDS.indexOf(slot) + 1, total: EXPERT_SLOT_IDS.length }
        : null,
  };
}

/** Projection de reprise native — quatre domaines, aucune taxonomie V1. */
export interface NativeRecoveryDomainHttpView {
  readonly status: string;
  readonly available_actions: readonly NativeRecoveryActionId[];
  readonly conflicts: readonly string[];
}

export interface NativeRecoveryHttpView {
  readonly generation: 'NATIVE_V21_EXECUTION';
  readonly revision: string;
  readonly operational_state: NativeRunReadModelV1['operational_state'];
  readonly recovery: NativeRunReadModelV1['recovery'];
}

/**
 * Vue opérationnelle d'un run natif, depuis un snapshot stable unique.
 *
 * Les trois faits canoniques ne sont lus qu'une fois. `read_model_version` est
 * porté par la projection elle-même, et reste la façon dont une surface future
 * reconnaît la forme qu'elle reçoit.
 */
export async function readNativeRunHttpView(
  deps: NativeReadHttpDeps,
  runId: string,
): Promise<NativeRunHttpView> {
  const snapshot = await readStableNativeRunSnapshot(deps.runsDir, runId);
  const run = await projectNativeRunReadModelFromSnapshot(snapshot, deps.maxTransferBytes);
  return {
    generation: 'NATIVE_V21_EXECUTION',
    revision: snapshot.revision,
    run,
    // Même instantané, donc même révision : deux lectures décriraient deux
    // mondes sous une seule empreinte.
    presentation: projectCockpitPresentation(snapshot),
    controversies: projectControversyReadModel(snapshot),
    controversy_revision: snapshot.controversy_revision,
    evidence: projectEvidenceReadModel(snapshot),
    reconciliations: projectReconciliationReadModel(snapshot),
    // Dérivé de la **même** projection, donc du même instantané : ce qui est
    // annoncé en vol est ce que la vue décrit, jamais un état relu depuis.
    in_flight: projectInFlight(run),
  };
}

/**
 * Vue de reprise d'un run natif.
 *
 * Rend les quatre domaines tels que 2D les classifie, avec la révision du
 * **même** snapshot : la future mutation de reprise devra porter
 * `expected_revision` correspondant à l'état effectivement montré à l'humain.
 *
 * `available_actions` reste consultatif. Un humain peut lire un geste puis
 * voir sa révision devenir périmée avant de le demander — c'est attendu, et
 * c'est précisément ce que la précondition existe pour constater.
 */
export async function readNativeRecoveryHttpView(
  deps: NativeReadHttpDeps,
  runId: string,
): Promise<NativeRecoveryHttpView> {
  const snapshot = await readStableNativeRunSnapshot(deps.runsDir, runId);
  const view = await projectNativeRunReadModelFromSnapshot(snapshot, deps.maxTransferBytes);
  return {
    generation: 'NATIVE_V21_EXECUTION',
    revision: snapshot.revision,
    operational_state: view.operational_state,
    recovery: view.recovery,
  };
}

// --------------------------------------------------------------------------
// Chronologie native (V2.1-IMP-19)
// --------------------------------------------------------------------------

/**
 * Page de chronologie native.
 *
 * Le contrat de pagination est **celui de la chronologie historique** —
 * `revision`, `entries`, `cursor_next`, `truncated`, `total` — et le curseur est
 * encodé par la même primitive. Inventer une seconde convention aurait donné
 * deux façons de dire la même chose, et deux façons de se tromper.
 *
 * Trois champs s'y ajoutent, et seulement parce qu'ils nomment ce que la forme
 * historique ne pouvait pas nommer : la génération, la version de projection, et
 * le run auquel la page appartient.
 */
export interface NativeTimelineHttpView {
  readonly generation: 'NATIVE_V21_EXECUTION';
  readonly timeline_version: number;
  readonly run_id: string;
  readonly revision: string;
  readonly entries: readonly NativeTimelineEntryV1[];
  readonly cursor_next: string | null;
  readonly truncated: boolean;
  readonly total: number;
}

export interface NativeTimelineOptions {
  readonly cursor?: string;
  readonly pageSize?: number;
}

/**
 * Rend une page de chronologie native.
 *
 * ```text
 * snapshot stable  →  révision exigée si curseur  →  découpe  →  projection
 * ```
 *
 * La découpe précède la projection : une page ne coûte que ses propres entrées.
 * Elle porte sur `snapshot.events`, jamais sur une seconde lecture du journal —
 * paginer en rouvrant `events.jsonl` rendrait une page issue d'un monde que la
 * révision annoncée ne décrit pas.
 *
 * `rounds/` n'est pas ouvert : les artefacts de round sont diagnostiques, et les
 * faits canoniques suffisent à raconter la controverse.
 */
export async function readNativeTimelineHttpView(
  deps: NativeReadHttpDeps,
  runId: string,
  options: NativeTimelineOptions = {},
): Promise<NativeTimelineHttpView> {
  const snapshot = await readStableNativeRunSnapshot(deps.runsDir, runId);
  const pageSize = options.pageSize ?? DEFAULT_TIMELINE_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new CcrError('INVALID_ARGUMENT', 'Taille de page invalide.');
  }

  let offset = 0;
  if (options.cursor !== undefined) {
    const decoded = decodeTimelineCursor(options.cursor);
    if (decoded.r !== snapshot.revision) {
      // Deux pages issues de deux révisions décriraient une controverse qui n'a
      // jamais eu lieu. Le refus est explicite ; le rechargement reste humain.
      throw new CcrError(
        'STALE_REVISION',
        "La chronologie a changé depuis l'émission de ce curseur. Rechargez la vue : " +
          'CCR ne fusionne pas deux pages issues de vues différentes.',
        { details: { expected: decoded.r, actual: snapshot.revision, at: 'timeline' } },
      );
    }
    offset = decoded.o;
  }

  const total = snapshot.events.length;
  const entries = projectNativeTimeline(
    snapshot.manifest,
    snapshot.events.slice(offset, offset + pageSize),
  );
  const nextOffset = offset + entries.length;
  const truncated = nextOffset < total;

  return {
    generation: 'NATIVE_V21_EXECUTION',
    timeline_version: NATIVE_TIMELINE_VERSION,
    run_id: snapshot.runId,
    revision: snapshot.revision,
    entries,
    cursor_next: truncated ? encodeTimelineCursor(snapshot.revision, nextOffset) : null,
    truncated,
    total,
  };
}

/** Ré-export de commodité : les surfaces n'ont pas à connaître le module 2D. */
export type { ExpertSlotId, NativeRunReadModelV1, NativeTimelineEntryV1 };
