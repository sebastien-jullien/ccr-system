/**
 * Intention de production d'un run **natif V2.1** — `end-production` et
 * `reactivate-production` (P3).
 *
 * ## Ce que ce module fait
 *
 * Il enregistre, de façon durable et append-only, une déclaration de l'autorité
 * de contrôle humaine :
 *
 * ```text
 * production_ended         aucun pas de production natif n'est présentement
 *                          prévu pour ce run
 * production_reactivated   des pas de production natifs sont de nouveau prévus
 * ```
 *
 * ```text
 * AUTORITÉ SÉMANTIQUE   l'autorité de contrôle humaine
 * CCR                   enregistreur technique
 * ```
 *
 * ## Ce que ce module n'est pas
 *
 * Ce n'est ni une machine d'état, ni un moteur de reprise, ni un juge.
 *
 * ```text
 * ROLE       ≠ AUTORITÉ DE FIN DE PRODUCTION
 * PROVIDER   ≠ ROLE
 * ```
 *
 * Ni `author`, ni `challenger`, ni `AUTOMATION` ne créent le fait P3. C'est
 * pourquoi l'événement ne porte **aucun** champ de slot : la validation les
 * refuse, si bien qu'aucune écriture ne peut lui attribuer un expert.
 *
 * Les dépendances n'exposent aucune fabrique d'adapter — même discipline que le
 * contrôle natif : c'est la preuve, au niveau du type, qu'aucun fournisseur ne
 * peut être invoqué depuis ce module.
 *
 * ## Aucune écriture d'état, et pas par prudence
 *
 * ```text
 * P3 → RunState   =   AUCUN
 * ```
 *
 * `applyNativeStateUpdate` valide toute écriture par `assertTransition`, et la
 * machine d'état **n'autorise aucune transition réflexive** : `READY → READY`
 * n'existe pas. Écrire `state.json` sans changer l'état est donc structurellement
 * impossible, et changer l'état est précisément ce que le contrat P3 interdit.
 *
 * Conséquence exacte, et assumée : `state.last_event_id` ne nomme pas un fait
 * P3. Ce champ est le témoin du dernier commit d'état, et P3 n'en produit aucun.
 * Aucun diagnostic de reprise n'en dépend à faux — les deux seuls résidus qui
 * lisent `last_event_id` exigent qu'un marqueur de clôture soit le **dernier**
 * fait du journal, et un fait P3 n'est jamais un marqueur de clôture.
 *
 * ## Un transfert en attente survit intact
 *
 * ```text
 * consommer · supplanter · résoudre · mettre en quarantaine   =   AUCUN
 * ```
 *
 * Après une fin de production, un run peut simultanément porter
 * `NO_STEPS_INTENDED` et une source transférable en attente. Ce ne sont pas deux
 * affirmations contradictoires : ce sont deux faits distincts, et aucun des deux
 * ne parle de l'autre.
 */

import { CcrError } from '../core/errors.ts';
import { deriveProductionIntent, hasProductionIntentFact } from '../core/production-intent.ts';
import type { ProductionIntent } from '../core/production-intent.ts';
import type {
  NativeRunManifest,
  NativeRunStateDocument,
  ProductionIntentEventType,
} from '../core/run-native.ts';
import { runPaths } from '../store/layout.ts';
import { openNativeEventStore } from '../store/native-event-store.ts';
import { readPersistedManifest, readPersistedState } from '../store/native-store.ts';
import { withNativeMutation } from './native-mutation-boundary.ts';
import type { NativeMutationBoundary } from './native-mutation-boundary.ts';

/**
 * Dépendances de l'intention de production — volontairement sans fabrique
 * d'adapter, comme le contrôle natif.
 */
export interface NativeProductionDeps {
  readonly runsDir: string;
  now(): Date;
}

export interface NativeProductionResult {
  readonly runId: string;
  /** Intention **après** l'opération, dérivée du journal. */
  readonly intent: ProductionIntent;
  /** Faux lorsque l'opération était déjà satisfaite : aucun événement produit. */
  readonly changed: boolean;
  /** Identifiant du fait durable écrit, `null` sur idempotence. */
  readonly eventId: string | null;
}

export interface EndProductionInput {
  /** Obligatoire sur `end-production`. Conservée verbatim, opaque à CCR. */
  readonly note: string;
  /** Valeur exacte de `--acknowledge-downgrade`, si l'appelant en a fourni une. */
  readonly acknowledgeDowngrade?: string | undefined;
}

/**
 * Entrée de réactivation — **sans acquittement de descente**, et pas par omission.
 *
 * Une réactivation ne peut pas être le premier fait P3 d'un run : elle n'est
 * effective que si l'intention courante vaut déjà `NO_STEPS_INTENDED`, ce qui
 * exige un `production_ended` antérieur. La frontière de compatibilité est donc
 * toujours déjà franchie quand elle écrit, et il n'y a rien à acquitter.
 *
 * Le champ est absent du type plutôt que présent et inutile : un acquittement
 * représentable mais sans effet serait une promesse.
 */
export interface ReactivateProductionInput {
  /** Facultative sur `reactivate-production`. */
  readonly note?: string | undefined;
}

interface LoadedNativeRun {
  readonly manifest: NativeRunManifest;
  readonly state: NativeRunStateDocument;
}

async function loadNativeRun(runsDir: string, runId: string): Promise<LoadedNativeRun> {
  const paths = runPaths(runsDir, runId);
  const persisted = await readPersistedManifest(paths);
  if (persisted.execution_mode !== 'NATIVE_V21_EXECUTION') {
    throw new CcrError(
      'COMMAND_UNSUPPORTED_FOR_GENERATION',
      `Le run ${runId} est de génération ${persisted.execution_mode} : l'intention de production ` +
        "appartient au protocole natif, et rien n'y est converti.",
      { details: { runId, execution_mode: persisted.execution_mode } },
    );
  }
  const stateDoc = await readPersistedState(paths);
  if (stateDoc.execution_mode !== 'NATIVE_V21_EXECUTION') {
    throw new CcrError('STATE_INVALID', `Le run ${runId} mélange les générations de documents.`, {
      details: { runId },
    });
  }
  return { manifest: persisted.manifest, state: stateDoc.document };
}

/**
 * Exige l'acquittement de descente **au premier fait P3 de ce run**, et là
 * seulement.
 *
 * Appelée après la détermination d'idempotence : une opération sans effet ne
 * franchit aucune frontière, et n'a donc rien à faire acquitter.
 *
 * La valeur de l'acquittement a déjà été confrontée à l'identité du run par la
 * surface d'appel — la règle vaut à tout instant, avant comme après la
 * frontière, et une mauvaise valeur n'est jamais ignorée au motif que la
 * frontière serait déjà franchie.
 */
function assertDowngradeAcknowledged(
  runId: string,
  alreadyCrossed: boolean,
  acknowledgement: string | undefined,
): void {
  if (alreadyCrossed) return;
  if (acknowledgement !== undefined) return;
  throw new CcrError(
    'DOWNGRADE_ACKNOWLEDGEMENT_REQUIRED',
    `Ce geste écrirait le premier fait d'intention de production du run ${runId}. À partir de là, ` +
      "le journal de ce run n'est plus lisible par une version antérieure de CCR : celle-ci refuse " +
      'un type de fait durable inconnu, franchement, plutôt que de le sauter en silence. Le run ' +
      "reste intact et aucun fait n'a été écrit. Pour confirmer cette frontière, reformez " +
      `l'invocation avec --acknowledge-downgrade ${runId}.`,
    { details: { runId, boundary: 'FIRST_P3_DURABLE_WRITE' } },
  );
}

/**
 * Écrit un fait d'intention de production, ou constate qu'il n'y a rien à
 * écrire.
 *
 * ```text
 * NOOP   =   l'intention demandée est déjà celle du run
 *        =   aucun événement, aucune note persistée, aucun historique fabriqué
 * ```
 *
 * Une idempotence n'est pas un refus : l'opération réussit, et n'écrit rien. Un
 * faux événement créé pour loger une note transformerait une absence de
 * changement en fait durable.
 */
async function recordProductionIntent(
  deps: NativeProductionDeps,
  runId: string,
  type: ProductionIntentEventType,
  target: ProductionIntent,
  note: string | undefined,
  acknowledgeDowngrade: string | undefined,
  boundary: NativeMutationBoundary | undefined,
): Promise<NativeProductionResult> {
  const paths = runPaths(deps.runsDir, runId);

  return withNativeMutation(
    {
      runsDir: deps.runsDir,
      runId,
      command:
        type === 'production_ended' ? 'native-end-production' : 'native-reactivate-production',
      ...(boundary === undefined ? {} : { boundary }),
    },
    async () => {
      const loaded = await loadNativeRun(deps.runsDir, runId);
      const store = await openNativeEventStore(paths, loaded.manifest);
      const history = await store.readAll();

      const current = deriveProductionIntent(history);
      if (current === target) {
        return { runId, intent: current, changed: false, eventId: null };
      }

      assertDowngradeAcknowledged(runId, hasProductionIntentFact(history), acknowledgeDowngrade);

      const event = await store.append({
        // Le round courant est un fait de contexte, jamais une consommation :
        // P3 n'ouvre ni ne referme aucun round, et n'avance pas le curseur.
        round: loaded.state.round,
        actor: 'human',
        type,
        // Verbatim, sans troncature ni normalisation. Absent du fil lorsque
        // aucune note n'a été fournie, plutôt que présent et vide.
        ...(note === undefined ? {} : { content: note }),
        timestamp: deps.now().toISOString(),
      });

      // Aucune écriture d'état : voir l'en-tête du module. Le journal est
      // l'autorité durable, et l'intention s'en dérive à chaque lecture.
      return { runId, intent: target, changed: true, eventId: event.event_id };
    },
  );
}

/**
 * Déclare qu'aucun pas de production natif supplémentaire n'est présentement
 * prévu pour ce run.
 *
 * Ne ferme pas le run, ne le suspend pas, ne rend ni ne prend le contrôle, ne
 * touche pas au quota, ne consomme aucune source, et n'affirme rien de la
 * matière du travail.
 */
export function endNativeProduction(
  deps: NativeProductionDeps,
  runId: string,
  input: EndProductionInput,
  boundary?: NativeMutationBoundary,
): Promise<NativeProductionResult> {
  return recordProductionIntent(
    deps,
    runId,
    'production_ended',
    'NO_STEPS_INTENDED',
    input.note,
    input.acknowledgeDowngrade,
    boundary,
  );
}

/**
 * Déclare que des pas de production natifs sont de nouveau prévus.
 *
 * Acte **distinct** d'une reprise de contrôle : il ne change ni l'état, ni le
 * propriétaire du contrôle, et ne relance rien. Il ne supprime ni ne réécrit le
 * fait de fin qui le précède — l'histoire durable reste entière.
 *
 * Il ne rend aucun pas admissible par lui-même : il lève la seule interdiction
 * que P3 posait, et laisse toutes les autres gardes à leur autorité propre.
 */
export function reactivateNativeProduction(
  deps: NativeProductionDeps,
  runId: string,
  input: ReactivateProductionInput = {},
  boundary?: NativeMutationBoundary,
): Promise<NativeProductionResult> {
  return recordProductionIntent(
    deps,
    runId,
    'production_reactivated',
    'STEPS_INTENDED',
    input.note,
    // Jamais d'acquittement : voir `ReactivateProductionInput`. La barrière est
    // tout de même traversée, et elle rend la main immédiatement puisque le run
    // porte nécessairement déjà un fait P3.
    undefined,
    boundary,
  );
}
