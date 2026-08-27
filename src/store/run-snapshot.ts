/**
 * Snapshot cohérent d'un run, et révision opaque
 * (CCR V2 V0.2 §10, §11 ; amendement d'implémentation V2-IMP-30).
 *
 * ## Défaut corrigé
 *
 * `CX2-008` — la lecture d'un run enchaîne quatre lectures indépendantes, sans
 * verrou ni contrôle de stabilité. Une vue peut donc associer un `state.json`
 * ancien à des événements récents, ou l'inverse, sans que rien ne le signale.
 *
 * ## Ce que fait ce module
 *
 * Une **lecture optimiste stable** : on observe la version physique de chaque
 * source, on lit, on réobserve. Si rien n'a bougé pendant la lecture, la
 * combinaison obtenue a réellement coexisté sur le disque — c'est un snapshot.
 * Sinon, on recommence, dans un budget borné.
 *
 * ## Ce qu'il ne fait pas
 *
 * - **Aucun run lock.** Un lecteur doit pouvoir observer un run pendant
 *   `WAITING_AGENT`, alors que le processus agent détient le verrou pour une
 *   durée pouvant atteindre le timeout fournisseur. Attendre le verrou
 *   rendrait une page inutilisable pendant des dizaines de minutes.
 * - **Aucune attente d'immobilité.** Une fenêtre cohérente suffit ; exiger
 *   ensuite que le run reste immobile provoquerait une famine pendant une
 *   activité soutenue.
 * - **Aucune projection UI.** Ce module rend des faits canoniques, pas une vue.
 *
 * ## Précédence des sources (V0.2 §9)
 *
 * ```text
 * manifest    identité · cwd · sessions natives · runtime snapshot
 * state       état courant · contrôle · agent actif · opération en vol
 * events      chronologie canonique
 * decisions   autorité normative humaine
 * rounds/     projection diagnostique — JAMAIS dans le snapshot
 * locks       observation opérationnelle — JAMAIS un fait canonique
 * ```
 *
 * Aucun fait d'état courant n'est reconstruit depuis `events.jsonl` : lorsque
 * `state.json` fait autorité, il fait autorité seul.
 */

import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';

import { CcrError } from '../core/errors.ts';
import type { CcrDecision, CcrEvent, RunManifest, RunStateDocument } from '../core/run.ts';
import { openDecisionStore } from './decision-store.ts';
import { openEventStore } from './event-store.ts';
import type { JournalReadSeams } from './event-store.ts';
import { runPaths } from './layout.ts';
import type { RunPaths } from './layout.ts';
import { readManifest, readState } from './state-store.ts';

// --------------------------------------------------------------------------
// Observation physique
// --------------------------------------------------------------------------

/**
 * Signature physique d'une source, opaque et comparable.
 *
 * `stat` est demandé en `bigint` : `mtimeNs` offre la résolution nanoseconde
 * du système de fichiers, là où `mtimeMs` peut ne pas distinguer deux
 * écritures rapprochées. On y joint la taille et l'index de fichier, afin
 * qu'un remplacement atomique — qui change l'identité du fichier sans
 * nécessairement changer sa taille — soit également détecté.
 *
 * Ces métadonnées servent **uniquement** à détecter une course. Elles
 * n'entrent pas dans la révision (§14) : un fichier recopié à contenu
 * identique ne doit pas produire une révision différente.
 */
type SourceSignature = string;

const ABSENT: SourceSignature = 'ABSENT';

async function observe(file: string): Promise<SourceSignature> {
  try {
    const s = await stat(file, { bigint: true });
    return `${s.size.toString()}|${s.mtimeNs.toString()}|${s.ctimeNs.toString()}|${s.ino.toString()}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ABSENT;
    throw error;
  }
}

/** Les quatre sources canoniques, et elles seules. */
async function observeAll(paths: RunPaths): Promise<readonly SourceSignature[]> {
  return Promise.all([
    observe(paths.manifest),
    observe(paths.state),
    observe(paths.events),
    observe(paths.decisions),
  ]);
}

function sameObservation(a: readonly SourceSignature[], b: readonly SourceSignature[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

// --------------------------------------------------------------------------
// Budget
// --------------------------------------------------------------------------

/**
 * Budget de stabilisation, **distinct** de celui du fragment JSONL (0B).
 *
 * Les deux ne traitent pas le même phénomène : l'un attend qu'une ligne
 * finisse d'être écrite, l'autre attend une fenêtre sans écriture. Les
 * confondre rendrait l'un des deux inexplicable.
 */
export interface SnapshotRetryBudget {
  /** Tentatives **totales**, première lecture comprise. */
  readonly attempts: number;
  readonly delaysMs: readonly number[];
}

export const DEFAULT_SNAPSHOT_RETRY: SnapshotRetryBudget = {
  attempts: 6,
  delaysMs: [2, 5, 10, 20, 40],
};

// --------------------------------------------------------------------------
// Snapshot
// --------------------------------------------------------------------------

export interface RunSnapshot {
  readonly runId: string;
  readonly paths: RunPaths;
  readonly manifest: RunManifest;
  readonly state: RunStateDocument;
  readonly events: readonly CcrEvent[];
  readonly decisions: readonly CcrDecision[];
  /** Empreinte opaque des faits canoniques ci-dessus. */
  readonly revision: string;
  /** Diagnostic : tentatives consommées pour obtenir une fenêtre stable. */
  readonly attempts: number;
}

export interface ReadSnapshotOptions {
  readonly budget?: SnapshotRetryBudget;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Seams transmis aux lecteurs de journaux (0B). */
  readonly journal?: JournalReadSeams;
  /** Diagnostic interne : une source a changé pendant la lecture. */
  readonly onUnstable?: (attempt: number) => void;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Lit un snapshot cohérent des quatre sources canoniques d'un run.
 *
 * Ne prend aucun verrou. Échoue explicitement plutôt que de rendre un mélange
 * dont la cohérence n'a pas été établie.
 */
export async function readStableRunSnapshot(
  runsDir: string,
  runId: string,
  options: ReadSnapshotOptions = {},
): Promise<RunSnapshot> {
  const paths = runPaths(runsDir, runId);
  const budget = options.budget ?? DEFAULT_SNAPSHOT_RETRY;
  const sleep = options.sleep ?? defaultSleep;
  const journal = options.journal ?? {};

  for (let attempt = 1; ; attempt += 1) {
    const before = await observeAll(paths);

    // Ordre de lecture indifférent : c'est la réobservation qui tranche.
    const manifest = await readManifest(paths);
    const state = await readState(paths);
    const events = await (await openEventStore(paths, runId, journal)).readAll();
    const decisions = await (await openDecisionStore(paths, runId, journal)).readAll();

    const after = await observeAll(paths);
    if (sameObservation(before, after)) {
      return {
        runId,
        paths,
        manifest,
        state,
        events,
        decisions,
        revision: computeRunRevision({ manifest, state, events, decisions }),
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

// --------------------------------------------------------------------------
// Révision
// --------------------------------------------------------------------------

/**
 * Entrées du calcul de révision.
 *
 * Typées `object` plutôt que par les documents historiques depuis
 * V2.1-IMP-17A : le corps de `computeRunRevision` n'appelle aucune méthode
 * propre à une génération — quatre `JSON.stringify` et deux longueurs — et la
 * signature était la seule chose qui le liait à schema 1/2.
 *
 * `object` et non `unknown` : une chaîne ou un nombre passé par distraction
 * produirait une empreinte parfaitement valide et parfaitement fausse.
 *
 * L'élargissement ne touche ni l'algorithme, ni le préfixe, ni l'ordre de
 * sérialisation : une révision historique reste octet pour octet la même.
 */
export interface RevisionInputs {
  readonly manifest: object;
  readonly state: object;
  readonly events: readonly object[];
  readonly decisions: readonly object[];
}

/** Préfixe versionné : une évolution du calcul ne doit jamais être silencieuse. */
const REVISION_SCHEME = 'sha256';

/**
 * Empreinte opaque de la vue canonique.
 *
 * Propriétés garanties, toutes testées :
 *
 * - **déterministe** pour exactement les mêmes faits canoniques ;
 * - **couvre les quatre sources** — jamais `state.last_event_id` seul, qu'une
 *   commande V1.1 existante (`ccr setup --run`) désynchronise déjà du journal ;
 * - **indépendante de `rounds/`**, du verrou, et des métadonnées de fichier :
 *   un fichier recopié à contenu identique produit la même révision ;
 * - **taille fixe** (`sha256:` + 64 caractères) ;
 * - **ne révèle rien** : ni prompt, ni `cwd`, ni identifiant de session, ni
 *   décision, ni contenu d'agent — seulement un condensat.
 */
export function computeRunRevision(inputs: RevisionInputs): string {
  const digest = createHash('sha256');
  digest.update('ccr-run-revision/1\n');
  digest.update(`manifest:${JSON.stringify(inputs.manifest)}\n`);
  digest.update(`state:${JSON.stringify(inputs.state)}\n`);
  digest.update(`events:${String(inputs.events.length)}:${JSON.stringify(inputs.events)}\n`);
  digest.update(`decisions:${String(inputs.decisions.length)}:${JSON.stringify(inputs.decisions)}`);
  return `${REVISION_SCHEME}:${digest.digest('hex')}`;
}

// --------------------------------------------------------------------------
// Précondition de vue
// --------------------------------------------------------------------------

/**
 * Vérifie qu'une action a été proposée sur la vue courante.
 *
 * Fonction **pure** : elle n'ouvre rien, n'écrit rien, ne mute rien. Le
 * câblage sous run lock des mutations HTTP appartient au slice concerné
 * (V0.2 §11.2) ; ce qui est fourni ici est la primitive, et sa sémantique
 * d'erreur.
 */
export function assertExpectedRevision(expected: string, actual: string): void {
  if (expected === actual) return;
  throw new CcrError(
    'STALE_REVISION',
    "La vue sur laquelle cette action a été demandée n'est plus la vue courante du run. " +
      'Rechargez avant de recommencer : aucune action n’a été effectuée.',
    // Les deux empreintes sont des condensats : les exposer ne divulgue rien.
    { details: { expected, actual } },
  );
}
