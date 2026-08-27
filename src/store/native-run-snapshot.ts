/**
 * Snapshot cohérent d'un run **natif V2.1**, et sa révision
 * (V2.1-IMP-17A, fondation de concurrence HTTP).
 *
 * ## Pourquoi un module voisin, et non une généralisation
 *
 * `RunSnapshot` historique est typé `RunManifest` / `RunStateDocument` /
 * `CcrEvent[]`, et ce type irrigue tout le read model V2 gelé —
 * `cockpit-read-model`, `run-liveness`, `recovery-planner`,
 * `deriveRunCapabilities`. Le rendre bi-génération propagerait les types natifs
 * dans quatre slices gelés pour un bénéfice nul. Le contrat **externe** est
 * en revanche rigoureusement le même, et c'est lui qui compte :
 *
 * ```text
 * observe  →  lit  →  réobserve  →  retry si instable  →  SNAPSHOT_UNSTABLE
 * ```
 *
 * ## Aucun verrou
 *
 * Délibérément, et pour la même raison qu'en historique : un `GET` doit pouvoir
 * observer un run pendant qu'un HANDOFF détient le run lock — parfois pendant
 * toute une intervention humaine. Attendre le verrou rendrait la page
 * inutilisable exactement quand elle est le plus utile.
 *
 * Le mécanisme d'observation est d'ailleurs **générationnellement neutre** : il
 * n'ouvre ni ne parse aucun fichier, il ne fait que `stat`. Seules les lectures
 * intercalées changent de parseur.
 *
 * ## Sources
 *
 * ```text
 * manifest.json           identité · cwd · bindings d'experts · snapshot runtime
 * state.json              état · contrôle · round · curseur · contexte engagé
 * events.jsonl            chronologie canonique
 * controversies.jsonl     journal V3 — additif, hors révision de run
 * evidence.jsonl          journal V4 — additif, hors révision de run
 * reconciliations.jsonl   journal V5 — additif, hors révision de run
 * ```
 *
 * `decisions.jsonl` n'a **aucun** écrivain ni lecteur natif en V2.1 : la liste
 * vide transmise au calcul de révision n'est pas un oubli, c'est ce qui permet
 * de conserver l'algorithme historique octet pour octet.
 *
 * `rounds/`, `artifacts/` et `.ccr.lock` en sont exclus. Ce ne sont pas des
 * faits canoniques : `rounds/` est un artefact diagnostique, et le verrou une
 * observation opérationnelle. C'est exactement la frontière déjà tracée par le
 * contrat historique, qui expose `lock_observation` dans sa vue sans le faire
 * participer à sa révision.
 */

import type { ControversyEntry } from '../core/controversy.ts';
import type { EvidenceEntry } from '../core/evidence.ts';
import type { ReconciliationEntry } from '../core/reconciliation.ts';
import { CcrError } from '../core/errors.ts';
import type { NativeCcrEvent, NativeRunManifest, NativeRunStateDocument } from '../core/run-native.ts';
import { stat } from 'node:fs/promises';

import type { JournalReadSeams } from './event-store.ts';
import { runPaths } from './layout.ts';
import type { RunPaths } from './layout.ts';
import { readControversyJournal } from './controversy-store.ts';
import { readEvidenceJournal } from './evidence-store.ts';
import { readReconciliationJournal } from './reconciliation-store.ts';
import { openNativeEventStore } from './native-event-store.ts';
import { readPersistedManifest, readPersistedState } from './native-store.ts';
import { computeRunRevision, DEFAULT_SNAPSHOT_RETRY } from './run-snapshot.ts';
import type { SnapshotRetryBudget } from './run-snapshot.ts';

// --------------------------------------------------------------------------
// Observation physique
// --------------------------------------------------------------------------

/**
 * Signature physique d'une source, opaque et comparable.
 *
 * Identique à celle du snapshot historique, et pour les mêmes raisons :
 * `mtimeNs` distingue deux écritures rapprochées là où `mtimeMs` peut échouer,
 * et l'index de fichier détecte un remplacement atomique à taille constante.
 *
 * Ces métadonnées ne servent qu'à détecter une course. Elles n'entrent jamais
 * dans la révision : un fichier recopié à contenu identique doit produire la
 * même empreinte.
 */
type SourceSignature = string;

const ABSENT: SourceSignature = 'ABSENT';

async function observe(file: string): Promise<SourceSignature> {
  try {
    const s = await stat(file, { bigint: true });
    return `${s.size.toString()}|${s.mtimeNs.toString()}|${s.ctimeNs.toString()}|${s.ino.toString()}`;
  } catch (error) {
    // Un `events.jsonl` absent est une forme légitime au tout début d'un run :
    // le store la traite comme un journal vide, et l'absence est donc une
    // observation comme une autre — jamais une corruption.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ABSENT;
    throw error;
  }
}

/**
 * Les six sources canoniques natives, et elles seules.
 *
 * `controversies.jsonl` a rejoint la frontière en V3 (contrat `C-1`),
 * `evidence.jsonl` en V4 (contrat V4 §15.1), `reconciliations.jsonl` en V5
 * (contrat V5 §30). Le motif est le même à chaque fois : écrire sous le verrou
 * de run ne suffit pas — sans cette observation, une lecture combinée pourrait
 * rendre un état de run et un journal qui n'ont jamais coexisté, exactement la
 * vue que ce protocole existe pour interdire.
 *
 * L'extension est **additive** : les cinq sources historiques gardent leur
 * sémantique, leurs noms de champs, leurs domaines de révision et leurs règles
 * d'analyse, sans exception.
 *
 * Une absence produit `ABSENT`, signature stable comme les autres. Aucun run
 * antérieur n'a besoin de voir un journal créé pour être lu.
 */
export const NATIVE_STABLE_SNAPSHOT_SOURCE_COUNT = 6;

async function observeAll(paths: RunPaths): Promise<readonly SourceSignature[]> {
  return Promise.all([
    observe(paths.manifest),
    observe(paths.state),
    observe(paths.events),
    observe(paths.controversies),
    observe(paths.evidence),
    observe(paths.reconciliations),
  ]);
}

function sameObservation(a: readonly SourceSignature[], b: readonly SourceSignature[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

// --------------------------------------------------------------------------
// Snapshot
// --------------------------------------------------------------------------

export interface NativeRunSnapshot {
  readonly runId: string;
  readonly paths: RunPaths;
  readonly manifest: NativeRunManifest;
  readonly state: NativeRunStateDocument;
  readonly events: readonly NativeCcrEvent[];
  /**
   * Entrées du journal V3, dans leur ordre d'append.
   *
   * Observées dans la **même** fenêtre stable que les trois sources
   * historiques. Une liste vide ne distingue pas un journal absent d'un journal
   * sans entrée : c'est `controversy_revision` qui porte cette différence.
   */
  readonly controversies: readonly ControversyEntry[];
  /**
   * Entrées du journal V4, dans leur ordre d'append.
   *
   * Observées dans la **même** fenêtre stable que les quatre autres sources. Une
   * liste vide ne distingue pas un journal absent d'un journal sans entrée :
   * c'est `evidence_revision` qui porte cette différence.
   *
   * Une seule liste, jamais deux : séparer matériaux et adductions serait une
   * projection, et le regroupement appartient au read model.
   */
  readonly evidence: readonly EvidenceEntry[];
  /**
   * Entrées du journal V5, dans leur ordre d'append.
   *
   * Observées dans la **même** fenêtre stable que les cinq autres sources. Une
   * liste vide ne distingue pas un journal absent d'un journal sans entrée :
   * c'est `reconciliation_revision` qui porte cette différence.
   *
   * Une seule liste, jamais trois : séparer propositions, actes humains et
   * réponses serait une projection, et le regroupement appartient au read model.
   * L'ordre est celui du journal — **jamais** reconstruit, jamais retrié par
   * horodatage, sorte, périmètre ou identité.
   *
   * ```text
   * SERVER ORDER  ≠  PREFERENCE
   * ```
   */
  readonly reconciliations: readonly ReconciliationEntry[];
  /**
   * Empreinte opaque des faits ci-dessus, au format historique.
   *
   * **Inchangée par V3, par V4 et par V5** : elle reste calculée sur manifest,
   * state et events, et sur rien d'autre. Ajouter, modifier ou supprimer une
   * entrée de controverse, d'evidence ou de réconciliation ne la fait pas bouger.
   */
  readonly revision: string;
  /**
   * Jeton de fraîcheur du domaine V3, capturé dans la même fenêtre stable.
   *
   * Portée distincte de `revision`, et espace de noms distinct : un tour
   * d'expert ne périme pas une controverse, et une entrée de controverse ne
   * périme pas le run.
   */
  readonly controversy_revision: string;
  /**
   * Jeton de fraîcheur du domaine V4, capturé dans la même fenêtre stable.
   *
   * Espace de noms distinct des deux autres : un tour d'expert ne périme pas une
   * adduction, et une adduction ne périme ni le run, ni une controverse.
   */
  readonly evidence_revision: string;
  /**
   * Jeton de fraîcheur du domaine V5, capturé dans la même fenêtre stable.
   *
   * Quatrième espace de noms, distinct des trois autres : un tour d'expert ne
   * périme pas un acte de réconciliation, et un acte de réconciliation ne périme
   * ni le run, ni une controverse, ni une adduction. Une égalité d'empreintes
   * entre deux domaines n'aurait aucune signification, et rien ici n'en déduit
   * quoi que ce soit.
   *
   * Ce module **transporte** ce jeton ; il n'impose aucune fraîcheur.
   *
   * ```text
   * SNAPSHOT OBSERVATION  ≠  FRESHNESS ENFORCEMENT
   * ```
   */
  readonly reconciliation_revision: string;
  /** Diagnostic : tentatives consommées pour obtenir une fenêtre stable. */
  readonly attempts: number;
}

export interface ReadNativeSnapshotOptions {
  readonly budget?: SnapshotRetryBudget;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Seams transmis au lecteur de journal. */
  readonly journal?: JournalReadSeams;
  /** Diagnostic interne : une source a changé pendant la lecture. */
  readonly onUnstable?: (attempt: number) => void;
  /**
   * Couture de test : les faits viennent d'être lus, la réobservation n'a pas
   * encore eu lieu.
   *
   * C'est le seul instant où une course peut être provoquée de façon
   * déterministe. Aucun appelant de production ne la fournit.
   */
  readonly beforeReobserve?: (attempt: number) => void | Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Lit un snapshot cohérent des six sources canoniques d'un run natif.
 *
 * Ne prend aucun verrou. Échoue explicitement plutôt que de rendre une
 * combinaison dont la coexistence n'a pas été établie.
 *
 * Refuse un run historique : ce module ne convertit rien, et une révision
 * native calculée sur des documents schema 1 ne voudrait rien dire.
 */
export async function readStableNativeRunSnapshot(
  runsDir: string,
  runId: string,
  options: ReadNativeSnapshotOptions = {},
): Promise<NativeRunSnapshot> {
  const paths = runPaths(runsDir, runId);
  const budget = options.budget ?? DEFAULT_SNAPSHOT_RETRY;
  const sleep = options.sleep ?? defaultSleep;
  const journal = options.journal ?? {};

  for (let attempt = 1; ; attempt += 1) {
    const before = await observeAll(paths);

    // Ordre de lecture indifférent : c'est la réobservation qui tranche.
    const persisted = await readPersistedManifest(paths);
    if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') {
      throw new CcrError(
        'SCHEMA_VERSION_UNSUPPORTED',
        `Le run ${runId} est de génération ${persisted.execution_mode} : le snapshot natif ne le lit pas.`,
        { details: { runId, execution_mode: persisted.execution_mode } },
      );
    }
    const stateDoc = await readPersistedState(paths);
    if (stateDoc.execution_mode !== 'NATIVE_V21_EXECUTION') {
      throw new CcrError('STATE_INVALID', `Le run ${runId} mélange les générations de documents.`, {
        details: { runId },
      });
    }
    const events = await (await openNativeEventStore(paths, persisted.manifest, journal)).readAll();
    // Lus DANS la fenêtre : la réobservation ci-dessous couvre les cinq
    // sources, journaux V3 et V4 compris.
    const controversies = await readControversyJournal(paths, journal);
    const evidence = await readEvidenceJournal(paths, journal);
    // Lu DANS la fenêtre, comme les autres. Une corruption stable du journal V5
    // lève ici : le snapshot ne la convertit jamais en source vide, absente ou
    // « zéro réconciliation ». SNAPSHOT READ ≠ JOURNAL REPAIR.
    const reconciliations = await readReconciliationJournal(paths, journal);

    await options.beforeReobserve?.(attempt);

    const after = await observeAll(paths);
    if (sameObservation(before, after)) {
      return {
        runId,
        paths,
        manifest: persisted.manifest,
        state: stateDoc.document,
        events,
        controversies: controversies.entries,
        evidence: evidence.entries,
        reconciliations: reconciliations.entries,
        revision: computeNativeRunRevision(persisted.manifest, stateDoc.document, events),
        controversy_revision: controversies.revision,
        evidence_revision: evidence.revision,
        reconciliation_revision: reconciliations.revision,
        attempts: attempt,
      };
    }

    // Une source a bougé pendant la lecture : la combinaison obtenue n'a
    // peut-être jamais coexisté. On ne la rend jamais « quand même ».
    if (attempt >= budget.attempts) {
      throw new CcrError(
        'SNAPSHOT_UNSTABLE',
        `Le run ${runId} a été modifié pendant chacune des ${String(budget.attempts)} tentatives de lecture ` +
          "cohérente. Aucune vue stable n'a pu être établie.",
        { details: { runId, attempts: budget.attempts } },
      );
    }

    options.onUnstable?.(attempt);
    await sleep(budget.delaysMs[attempt - 1] ?? budget.delaysMs.at(-1) ?? 40);
  }
}

/**
 * Révision d'un run natif — **le même algorithme, le même format**.
 *
 * Aucun préfixe de génération n'est introduit. Il serait inutile : une révision
 * n'est jamais comparée qu'à une révision calculée pour le **même** run, sous
 * son verrou, et la génération d'un run est immuable. Le run fournit donc
 * lui-même l'espace de noms, et une collision sémantique est structurellement
 * impossible.
 *
 * `decisions` vaut la liste vide : aucun écrivain natif ne produit ce journal en
 * V2.1. Le passer explicitement conserve l'algorithme historique intact plutôt
 * que d'en dériver une variante.
 */
export function computeNativeRunRevision(
  manifest: NativeRunManifest,
  state: NativeRunStateDocument,
  events: readonly NativeCcrEvent[],
): string {
  return computeRunRevision({ manifest, state, events, decisions: [] });
}
