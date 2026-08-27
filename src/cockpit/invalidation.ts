/**
 * Invalidation des vues cockpit — écritures externes (V0.2 §22, V2-IMP-42).
 *
 * Le cockpit n'est pas le seul à écrire. `ccr pause`, `ccr decide`, un `recover`
 * lancé au terminal, ou n'importe quel processus CCR modifient les mêmes
 * fichiers sans partager la moindre mémoire avec le serveur. Ce module observe
 * ces écritures et dit une seule chose : **quelque chose concernant ce run a
 * changé**.
 *
 * ## Ce qu'il ne fait pas
 *
 * Il ne transporte aucune vérité. Ni état, ni titre, ni événement, ni contenu
 * d'agent. Un client invalidé relit les read models canoniques, qui restent la
 * seule source de vérité. Une invalidation perdue n'a donc d'autre conséquence
 * qu'un rafraîchissement retardé — jamais une perte de fait métier.
 *
 * ## Deux observateurs, et un seul qui fasse foi
 *
 * ```text
 * fs.watch       indice. Ni fiable, ni portable, ni exhaustif.
 * réconciliation toutes les 2 s, et seulement si quelqu'un regarde.
 * ```
 *
 * `fs.watch` avance la détection quand il fonctionne ; la réconciliation la
 * garantit quand il ne fonctionne pas. Aucune activité disque n'a lieu tant
 * qu'aucun client n'est abonné.
 *
 * ## Marqueurs, pas révisions
 *
 * Le discriminant est délibérément **plus large** que la révision canonique :
 * un verrou de run qui apparaît ou disparaît ne change aucun fait canonique,
 * mais change la vue de reprise et ses capacités. La révision, elle, reste
 * exactement ce qu'elle était — ce module ne la touche pas.
 *
 * Le marqueur est une empreinte de `stat` : taille et date de modification des
 * fichiers du run, plus celles du verrou. Aucun fichier n'est ouvert, aucun
 * document n'est analysé, rien n'est reconstruit. C'est un marqueur de version,
 * pas une lecture — et il ne prétend pas prouver l'absence de changement :
 * c'est le client qui, une fois invalidé, va chercher la vérité.
 */

import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { isRunId } from '../core/ids.ts';
import { lockFilePath } from '../lock/run-lock.ts';
import { runPaths } from '../store/layout.ts';

/** Cadence normative : §22.4. Jamais plus court, jamais conditionnel. */
export const RECONCILIATION_INTERVAL_MS = 2_000;

/** Fenêtre de coalescence des indices `fs.watch`. Une rafale, un examen. */
const HINT_COALESCE_MS = 120;

/**
 * Charge utile d'une invalidation.
 *
 * Une ressource et un instant. Rien d'autre n'a le droit d'y figurer : ce
 * message traverse un canal qui n'offre aucune garantie de livraison, et tout
 * ce qu'il transporterait deviendrait une vérité que personne ne peut relire.
 */
export interface InvalidationMessage {
  readonly type: 'invalidate';
  readonly resource: 'run' | 'runs';
  readonly run_id?: string;
  readonly at: string;
}

export type InvalidationScope = { readonly kind: 'run'; readonly runId: string } | { readonly kind: 'list' };

export interface InvalidationHubOptions {
  readonly runsDir: string;
  readonly intervalMs?: number;
  readonly now?: () => Date;
  /** Couture de test : compte les réconciliations réellement exécutées. */
  readonly onReconciled?: (watchedRuns: number) => void;
}

export interface InvalidationHub {
  /**
   * Abonne un client. Le retour désabonne.
   *
   * L'abonnement ne déclenche aucune invalidation : c'est le transport qui en
   * émet une à l'ouverture, parce que c'est lui qui sait qu'une connexion vient
   * de naître ou de renaître.
   */
  subscribe(scope: InvalidationScope, deliver: (message: InvalidationMessage) => void): () => void;
  /** Nombre d'abonnés, toutes portées confondues. Diagnostic. */
  subscriberCount(): number;
  /** Vrai lorsque l'observation tourne — donc lorsque quelqu'un regarde. */
  isObserving(): boolean;
  /** Arrête tout : minuterie, surveillance, abonnés. Idempotent. */
  stop(): void;
}

interface Subscription {
  readonly scope: InvalidationScope;
  readonly deliver: (message: InvalidationMessage) => void;
}

/** Empreinte d'un fichier : présent ou non, sa taille, sa date. Jamais son contenu. */
async function markerOf(file: string): Promise<string> {
  try {
    const info = await stat(file);
    return `${String(info.size)}:${String(info.mtimeMs)}`;
  } catch {
    return '-';
  }
}

export function createInvalidationHub(options: InvalidationHubOptions): InvalidationHub {
  const runsDir = options.runsDir;
  const intervalMs = options.intervalMs ?? RECONCILIATION_INTERVAL_MS;
  const now = options.now ?? ((): Date => new Date());

  const subscriptions = new Set<Subscription>();
  const signatures = new Map<string, string>();

  let timer: NodeJS.Timeout | undefined;
  let watcher: FSWatcher | undefined;
  let hintTimer: NodeJS.Timeout | undefined;
  let inspecting = false;
  let stopped = false;

  const watchedRunIds = (): string[] => {
    const ids = new Set<string>();
    for (const subscription of subscriptions) {
      if (subscription.scope.kind === 'run') ids.add(subscription.scope.runId);
    }
    return [...ids];
  };

  const watchesList = (): boolean => {
    for (const subscription of subscriptions) {
      if (subscription.scope.kind === 'list') return true;
    }
    return false;
  };

  /**
   * Empreinte d'un run : ses quatre fichiers canoniques, et son verrou.
   *
   * Le verrou y figure parce que la vue de reprise en dépend, alors que la
   * révision canonique l'ignore — délibérément, et cela ne change pas ici.
   */
  async function runSignature(runId: string): Promise<string> {
    const paths = runPaths(runsDir, runId);
    const markers = await Promise.all([
      markerOf(paths.manifest),
      markerOf(paths.state),
      markerOf(paths.events),
      markerOf(paths.decisions),
      markerOf(lockFilePath(paths)),
    ]);
    return markers.join('|');
  }

  /**
   * Empreinte de la liste : les runs présents, et l'état de chacun.
   *
   * Un `stat` par run, jamais une lecture : la liste montre des états, donc
   * l'apparition d'un run ne suffit pas à la décrire. Le coût reste celui d'un
   * appel système par run, sans ouverture ni analyse — très loin d'une
   * reconstruction du modèle de lecture.
   */
  async function listSignature(): Promise<string> {
    let entries: string[];
    try {
      entries = (await readdir(runsDir)).filter((name) => isRunId(name)).sort();
    } catch {
      return '-';
    }
    const markers = await Promise.all(
      entries.map(async (runId) => `${runId}=${await markerOf(runPaths(runsDir, runId).state)}`),
    );
    return markers.join(',');
  }

  function emit(scope: InvalidationScope): void {
    const message: InvalidationMessage =
      scope.kind === 'run'
        ? { type: 'invalidate', resource: 'run', run_id: scope.runId, at: now().toISOString() }
        : { type: 'invalidate', resource: 'runs', at: now().toISOString() };
    for (const subscription of subscriptions) {
      if (subscription.scope.kind !== scope.kind) continue;
      if (scope.kind === 'run' && subscription.scope.kind === 'run' && subscription.scope.runId !== scope.runId) continue;
      subscription.deliver(message);
    }
  }

  /**
   * Un tour d'observation.
   *
   * Rien n'est émis quand rien n'a bougé : c'est la propriété qui distingue ce
   * mécanisme d'un rafraîchissement périodique déguisé.
   */
  async function inspect(): Promise<void> {
    if (inspecting || stopped) return;
    inspecting = true;
    try {
      const runIds = watchedRunIds();
      for (const runId of runIds) {
        const key = `run:${runId}`;
        const signature = await runSignature(runId);
        const previous = signatures.get(key);
        signatures.set(key, signature);
        if (previous !== undefined && previous !== signature) emit({ kind: 'run', runId });
      }
      if (watchesList()) {
        const signature = await listSignature();
        const previous = signatures.get('list');
        signatures.set('list', signature);
        if (previous !== undefined && previous !== signature) emit({ kind: 'list' });
      }
      // Oublie ce que plus personne ne regarde : la table suit les abonnés.
      for (const key of [...signatures.keys()]) {
        if (key === 'list') {
          if (!watchesList()) signatures.delete(key);
          continue;
        }
        if (!runIds.includes(key.slice(4))) signatures.delete(key);
      }
      options.onReconciled?.(runIds.length);
    } finally {
      inspecting = false;
    }
  }

  function scheduleHint(): void {
    if (hintTimer !== undefined || stopped) return;
    hintTimer = setTimeout(() => {
      hintTimer = undefined;
      void inspect();
    }, HINT_COALESCE_MS);
    hintTimer.unref?.();
  }

  function startObserving(): void {
    if (timer !== undefined || stopped) return;
    timer = setInterval(() => void inspect(), intervalMs);
    timer.unref?.();
    try {
      // Indice seulement : son absence ne dégrade que la latence, jamais la
      // correction. Les plateformes qui ne savent pas surveiller récursivement
      // se contentent donc de la réconciliation.
      watcher = watch(runsDir, { recursive: true }, () => scheduleHint());
      watcher.on('error', () => {
        watcher?.close();
        watcher = undefined;
      });
    } catch {
      watcher = undefined;
    }
  }

  function stopObserving(): void {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    if (hintTimer !== undefined) {
      clearTimeout(hintTimer);
      hintTimer = undefined;
    }
    watcher?.close();
    watcher = undefined;
    signatures.clear();
  }

  return {
    subscribe(scope, deliver) {
      if (stopped) return () => undefined;
      const subscription: Subscription = { scope, deliver };
      subscriptions.add(subscription);
      startObserving();
      // Empreinte de départ : sans elle, le premier tour invaliderait sans
      // qu'aucun changement ait eu lieu.
      void inspect();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        subscriptions.delete(subscription);
        if (subscriptions.size === 0) stopObserving();
      };
    },
    subscriberCount: () => subscriptions.size,
    isObserving: () => timer !== undefined,
    stop() {
      stopped = true;
      subscriptions.clear();
      stopObserving();
    },
  };
}
