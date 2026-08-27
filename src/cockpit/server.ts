/**
 * Serveur HTTP local du cockpit — **lecture seule** (Slice 2).
 *
 * ## Ce que ce serveur est
 *
 * Une surface de transport devant le Read Model du Slice 1. Il ne devient ni
 * une seconde machine CCR, ni une seconde source de vérité, ni un moteur de
 * reprise, ni un orchestrateur alternatif : chaque route appelle une primitive
 * de lecture existante et rend son résultat.
 *
 * Il n'y a donc **aucun cache** de `RunView` ici. Un cache serveur aurait sa
 * propre notion de fraîcheur, à côté de la révision — c'est-à-dire une seconde
 * autorité (INV-20-01, INV-20-05). Chaque `GET` relit.
 *
 * ## Chaîne de contrôle d'une requête
 *
 * ```text
 * borne d'URL      →  400   une requête énorme n'alloue rien
 * Host strict      →  403   défense DNS rebinding (§25.3)
 * méthode          →  405   aucune mutation n'existe dans ce slice
 * routage          →  404
 * session          →  401   sauf « / », qui la pose
 * lecture          →  read model, tel quel
 * ```
 *
 * L'ordre n'est pas arbitraire : `Host` précède la méthode et la session pour
 * qu'une origine non canonique n'apprenne rien de la surface réelle.
 *
 * ## Ce qui est délibérément absent
 *
 * Aucun SSE, aucun frontend applicatif, aucune mutation, aucun reçu, aucun
 * `fs.watch`, aucun compteur d'admission. Ces éléments appartiennent aux
 * slices suivants et ne sont pas préfigurés par des routes vides.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { CcrError } from '../core/errors.ts';
import { isRunId } from '../core/ids.ts';
import { loadEffectiveConfig } from '../config/config-store.ts';
import { runDoctor, toDisplayPath } from '../services/doctor-service.ts';
import type { DoctorReport } from '../services/doctor-service.ts';
import {
  getRecoveryView,
  getRunView,
  getTimeline,
  listCockpitRuns,
} from '../services/cockpit-read-model.ts';
import type { CockpitReadModelDeps } from '../services/cockpit-read-model.ts';
import { readRunGeneration } from '../store/run-directory.ts';
import {
  readNativeRecoveryHttpView,
  readNativeRunHttpView,
  readNativeTimelineHttpView,
} from './native-read-http.ts';
import { loadCockpitAsset, loadCockpitShell } from './assets.ts';
import { operationEffect } from '../services/invocation-effect.ts';
import { isOperationId, toPublicReceipt } from './operations-store.ts';
import { createInvalidationHub } from './invalidation.ts';
import type { InvalidationHub, InvalidationMessage, InvalidationScope } from './invalidation.ts';
import type { OperationStore } from './operations-store.ts';
import {
  executeControversyMutation,
  executeEvidenceMutation,
  executeNativeRecoveryMutation,
  executeReconciliationMutation,
  executeRecoveryMutation,
  executeStartMutation,
  CONTROVERSY_MUTATION_ROUTE_SEGMENT,
  EVIDENCE_MUTATION_ROUTE_SEGMENT,
  RECONCILIATION_MUTATION_ROUTE_SEGMENT,
  LONG_MUTATION_ROUTES,
  RECOVERY_ROUTES,
  MAX_REQUEST_BODY_BYTES,
  assertCanonicalOrigin,
  executeLongMutation,
  executeShortMutation,
} from './mutations-http.ts';
import type { LongOperationManager } from './long-operations.ts';
import type { LongMutationHooks } from '../services/long-mutations.ts';
import type { ShortMutationSeams } from '../services/short-mutations.ts';
import type { RunRuntimeSettings, RunServiceDeps } from '../services/run-service.ts';
import type { StartMutationHooks } from '../services/start-mutation.ts';
import type { CanonicalRecoveryHooks } from '../services/recovery-application-service.ts';
import type { ClearStaleRunLockHooks } from '../services/clear-stale-run-lock-service.ts';
type RecoveryHooksHttp = CanonicalRecoveryHooks & ClearStaleRunLockHooks;
import type { StartPreflightSeams } from '../services/start-application-service.ts';
import { publicErrorFor, transportError } from './http-errors.ts';
import type { PublicError } from './http-errors.ts';
import {
  createSessionSecret,
  readSessionCookie,
  sessionCookieHeader,
  sessionMatches,
} from './session.ts';
import type { CockpitDataRoot } from './data-root.ts';

/** Port local par défaut, conforme à l'URL affichée en V0.2 §32. */
export const DEFAULT_COCKPIT_PORT = 4317;

/** Seule adresse écoutée. Jamais `0.0.0.0`, jamais `::`, jamais une interface LAN. */
export const COCKPIT_BIND_ADDRESS = '127.0.0.1';

/** Bornes d'entrée. Aucune ne dépend d'une allocation proportionnelle à l'entrée. */
export const MAX_URL_LENGTH = 2048;
export const MAX_CURSOR_LENGTH = 512;
export const MAX_TIMELINE_LIMIT = 1000;

/** `POST` rejoint la liste : le Slice 4 introduit les mutations courtes. */
const ALLOWED_METHODS = 'GET, HEAD, POST';

/**
 * CSP — élargie au strict nécessaire par le Slice 3.
 *
 * Le Slice 2 pouvait tenir `default-src 'none'` seul : il ne servait aucun
 * script. Le frontend en sert désormais, et seules trois directives s'ouvrent —
 * `script-src`, `style-src`, `connect-src` — toutes bornées à `'self'`.
 *
 * Tout le reste reste fermé, y compris ce que le cockpit n'utilise pas
 * aujourd'hui : `img-src`, `font-src`, `media-src`, `worker-src` valent `'none'`
 * plutôt que d'hériter d'un défaut. Une directive absente est une permission
 * accordée par distraction.
 *
 * Ni `'unsafe-inline'`, ni `'unsafe-eval'`, ni `data:` : le shell ne contient
 * aucun script ni style en ligne, et aucun gestionnaire `on…=` en attribut.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'none'",
  "font-src 'none'",
  "media-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export interface CockpitServerOptions {
  readonly dataRoot: CockpitDataRoot;
  readonly readModel: CockpitReadModelDeps;
  readonly port?: number;
  /** Injection de test uniquement : la production en génère toujours un neuf. */
  readonly sessionSecret?: string;
  readonly configPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  /** Substitution de test ; par défaut, le doctor réel du dépôt. */
  readonly doctor?: () => Promise<DoctorReport>;
  /** Dépendances d'exécution des mutations courtes. */
  readonly runService?: RunServiceDeps;
  readonly operations?: OperationStore;
  /** Coutures de test de la section critique. */
  readonly seams?: ShortMutationSeams;
  /** Admission des opérations longues. */
  readonly manager?: LongOperationManager;
  readonly longHooks?: LongMutationHooks;
  /** Fabrique de dépendances de run paramétrée par le snapshot — `START` seul. */
  readonly createRunServiceDeps?: (runtime: RunRuntimeSettings) => RunServiceDeps;
  readonly preflightSeams?: StartPreflightSeams;
  readonly startHooks?: StartMutationHooks;
  readonly recoveryHooks?: RecoveryHooksHttp;
  /** Horloge — injectable pour les preuves. */
  readonly now?: () => Date;
  /** Cadence de réconciliation ; §22.4 en fixe la valeur de production. */
  readonly reconciliationIntervalMs?: number;
  /** Couture de test : un tour de réconciliation vient d'avoir lieu. */
  readonly onReconciled?: (watchedRuns: number) => void;
}

export interface RunningCockpitServer {
  readonly url: string;
  readonly port: number;
  /** Adresse réellement bindée, telle que l'OS la rapporte. */
  readonly address: string;
  readonly sessionSecret: string;
  close(): Promise<void>;
  /**
   * Coupe les connexions ouvertes sans arrêter le serveur.
   *
   * Sert aux preuves de reconnexion : un flux d'invalidation tombe, le client
   * en rouvre un, et le serveur l'invalide sans condition. Aucune production
   * n'appelle ceci.
   */
  dropConnections(): void;
}

// --------------------------------------------------------------------------
// Réponses
// --------------------------------------------------------------------------

function securityHeaders(): Record<string, string> {
  return {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    'X-Frame-Options': 'DENY',
  };
}

/** Observateur associé à chaque serveur créé. Aucune autre voie d'accès. */
const observers = new WeakMap<Server, InvalidationHub>();

function send(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  contentType: string,
  body: string,
  extra: Record<string, string> = {},
): void {
  const payload = Buffer.from(body, 'utf8');
  res.writeHead(status, {
    ...securityHeaders(),
    ...extra,
    'Content-Type': contentType,
    'Content-Length': String(payload.byteLength),
  });
  // `HEAD` : mêmes statut et en-têtes que `GET`, corps vide (§39).
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(payload);
}

/**
 * Ouvre un flux d'invalidation.
 *
 * Les mêmes garanties que le reste de la surface : `Host` exact, session déjà
 * vérifiée en amont, boucle locale, aucun CORS, `no-store`, `nosniff`. Aucune
 * exception n'est créée pour `EventSource` — il ne sait pas poser d'en-tête,
 * mais il envoie le cookie de session, ce qui suffit. Aucun jeton ne circule
 * dans l'URL.
 *
 * Une invalidation part **immédiatement**, sans condition. C'est la règle de
 * reconnexion : un client qui vient de se connecter — ou de se reconnecter —
 * ignore ce qu'il a manqué, et n'essaie pas de le savoir. Il relit.
 */
function openInvalidationStream(
  req: IncomingMessage,
  res: ServerResponse,
  hub: InvalidationHub,
  scope: InvalidationScope,
  now: () => Date,
): void {
  res.writeHead(200, {
    ...securityHeaders(),
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const write = (message: InvalidationMessage): void => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(message)}\n\n`);
  };

  const release = hub.subscribe(scope, write);
  res.on('close', release);
  res.on('error', release);

  write(
    scope.kind === 'run'
      ? { type: 'invalidate', resource: 'run', run_id: scope.runId, at: now().toISOString() }
      : { type: 'invalidate', resource: 'runs', at: now().toISOString() },
  );
}

function sendJson(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  value: unknown,
  extra: Record<string, string> = {},
): void {
  send(req, res, status, 'application/json; charset=utf-8', JSON.stringify(value), extra);
}

function sendError(
  req: IncomingMessage,
  res: ServerResponse,
  error: PublicError,
  extra: Record<string, string> = {},
): void {
  sendJson(req, res, error.status, error.body, extra);
}

function badRequest(): PublicError {
  return publicErrorFor(new CcrError('INVALID_ARGUMENT', 'Requête invalide.'));
}

/**
 * Lit un corps de requête, **borné**.
 *
 * Dépassement : refus déterministe, jamais une troncature silencieuse — un
 * corps tronqué serait une intention différente de celle que le client a
 * exprimée.
 */
function readBoundedBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > limit) {
        reject(new CcrError('PAYLOAD_TOO_LARGE', 'Corps de requête trop volumineux.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// --------------------------------------------------------------------------
// Validation d'entrée
// --------------------------------------------------------------------------

/**
 * Décode **une seule fois** un segment de chemin.
 *
 * Le double décodage est la faille classique : `%252e%252e` deviendrait `..`
 * au second passage. Ici il devient `%2e%2e`, qui n'est pas un `run_id`, et
 * s'arrête là.
 */
function decodeSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/**
 * Valide un identifiant de run **avant** tout contact avec le système de
 * fichiers.
 *
 * Aucun segment d'URL n'est jamais concaténé à un chemin : le read model reçoit
 * un identifiant déjà reconnu par `isRunId`, la même fonction que la CLI.
 */
function parseRunIdSegment(segment: string): string | undefined {
  const decoded = decodeSegment(segment);
  if (decoded === undefined) return undefined;
  return isRunId(decoded) ? decoded : undefined;
}

/** En-tête `Idempotency-Key`, sous sa forme scalaire. */
function readIdempotencyKey(req: IncomingMessage): string | undefined {
  const value = req.headers['idempotency-key'];
  return Array.isArray(value) ? value[0] : value;
}

/** Politique stricte : tout paramètre non déclaré est un refus, pas un oubli. */
function rejectUnknownParams(url: URL, allowed: readonly string[]): boolean {
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key)) return true;
  }
  return false;
}

interface TimelineQuery {
  readonly cursor?: string;
  readonly pageSize?: number;
}

function parseTimelineQuery(url: URL): TimelineQuery | undefined {
  if (rejectUnknownParams(url, ['cursor', 'limit'])) return undefined;

  const cursors = url.searchParams.getAll('cursor');
  const limits = url.searchParams.getAll('limit');
  if (cursors.length > 1 || limits.length > 1) return undefined;

  const query: { cursor?: string; pageSize?: number } = {};

  const cursor = cursors[0];
  if (cursor !== undefined) {
    if (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH) return undefined;
    query.cursor = cursor;
  }

  const limit = limits[0];
  if (limit !== undefined) {
    if (!/^[0-9]{1,4}$/.test(limit)) return undefined;
    const value = Number.parseInt(limit, 10);
    if (value < 1 || value > MAX_TIMELINE_LIMIT) return undefined;
    query.pageSize = value;
  }

  return query;
}

// --------------------------------------------------------------------------
// Projections sûres
// --------------------------------------------------------------------------

/**
 * Projection de configuration (§29).
 *
 * Uniquement les champs nécessaires au cockpit. Aucun credential, aucun secret,
 * aucun `process.env` brut. Le chemin du fichier est replié sur `~` : un
 * rapport partagé ne divulgue pas l'identifiant du poste.
 */
async function configProjection(options: CockpitServerOptions): Promise<unknown> {
  const effective = await loadEffectiveConfig(
    options.configPath === undefined ? {} : { configPath: options.configPath },
    options.env ?? process.env,
  );
  return {
    node_version: process.version,
    config_path: toDisplayPath(effective.configPath, options.home),
    config_origin: effective.configOrigin,
    preflight: {
      offer_interactive_login: effective.preflight.offerInteractiveLogin,
      source: effective.preflight.source,
    },
    codex: {
      skip_git_repo_check: effective.codex.skipGitRepoCheck,
      source: effective.codex.source,
    },
    legacy_env: {
      variable: effective.legacyEnv.variable,
      present: effective.legacyEnv.present,
      canonical: effective.legacyEnv.canonical,
      non_canonical: effective.legacyEnv.nonCanonical,
    },
  };
}

/**
 * Projection du `DoctorReport` (§31).
 *
 * Le rapport est rendu **sans recalculer ses conclusions** — le statut et les
 * constats sont ceux du modèle métier. Deux champs sont toutefois retirés :
 * `pid` et `hostname` du verrou de configuration, que §24.2 interdit
 * explicitement de faire franchir la frontière HTTP.
 */
function doctorProjection(report: DoctorReport): unknown {
  const { pid: _pid, hostname: _hostname, ...configLock } = report.configLock;
  return { ...report, configLock };
}

// --------------------------------------------------------------------------
// Serveur
// --------------------------------------------------------------------------

/**
 * Construit le serveur. Le port réellement bindé n'est connu qu'après
 * `listen()` : l'allowlist de `Host` est donc évaluée à chaque requête, sur la
 * valeur observée du socket, jamais sur la valeur demandée.
 */
function createCockpitServer(options: CockpitServerOptions, sessionSecret: string): Server {
  let boundPort = 0;

  const doctor =
    options.doctor ??
    ((): Promise<DoctorReport> =>
      runDoctor({
        runsDir: options.dataRoot.runsDir,
        ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.home === undefined ? {} : { home: options.home }),
      }));

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch(() => {
      if (!res.headersSent) sendError(req, res, transportError('INTERNAL_ERROR'));
      else res.end();
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawUrl = req.url ?? '';
    if (rawUrl.length > MAX_URL_LENGTH) {
      sendError(req, res, badRequest());
      return;
    }

    // `Host` d'abord : une autorité non canonique n'apprend rien de la surface.
    // `X-Forwarded-Host` n'est jamais lu — il n'existe aucun reverse proxy dans
    // le produit, donc aucune raison de faire confiance à cet en-tête.
    if (req.headers.host !== `${COCKPIT_BIND_ADDRESS}:${String(boundPort)}`) {
      sendError(req, res, transportError('INVALID_HOST'));
      return;
    }

    const method = req.method ?? '';
    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
      sendError(req, res, transportError('METHOD_NOT_ALLOWED'), { Allow: ALLOWED_METHODS });
      return;
    }

    let url: URL;
    try {
      url = new URL(rawUrl, `http://${COCKPIT_BIND_ADDRESS}:${String(boundPort)}`);
    } catch {
      sendError(req, res, badRequest());
      return;
    }

    // 2 puis 3 — session, puis origine, avant tout routage. Une mutation ne
    // doit jamais atteindre une route, pas même le bootstrap : `POST /` n'est
    // pas une façon d'obtenir le shell.
    if (method === 'POST') {
      if (!sessionMatches(sessionSecret, readSessionCookie(req.headers.cookie))) {
        sendError(req, res, transportError('UNAUTHENTICATED'));
        return;
      }
      try {
        // `SameSite=Strict` ne remplace pas ce contrôle : il dépend du
        // navigateur, celui-ci dépend de nous. `Referer` et les en-têtes
        // `X-Forwarded-*` ne sont jamais lus.
        assertCanonicalOrigin(req.headers.origin, `http://${COCKPIT_BIND_ADDRESS}:${String(boundPort)}`);
      } catch (error) {
        sendError(req, res, publicErrorFor(error));
        return;
      }
      await routeMutation(req, res, url);
      return;
    }

    if (url.pathname === '/') {
      if (url.search.length > 0) {
        sendError(req, res, badRequest());
        return;
      }
      // Seul point qui pose la session, et seul document servi sans elle.
      // Le shell est statique : aucune donnée CCR n'y est injectée côté serveur.
      send(req, res, 200, 'text/html; charset=utf-8', await loadCockpitShell(), {
        'Set-Cookie': sessionCookieHeader(sessionSecret),
      });
      return;
    }

    const isAsset = url.pathname.startsWith('/assets/');
    if (!isAsset && !url.pathname.startsWith('/api/')) {
      sendError(req, res, transportError('NOT_FOUND'));
      return;
    }

    // Les assets sont protégés comme le reste. Ils ne contiennent aucune donnée
    // CCR, mais les exempter créerait une seconde règle d'accès à maintenir —
    // et une exception est le meilleur endroit où une faille s'installe.
    if (!sessionMatches(sessionSecret, readSessionCookie(req.headers.cookie))) {
      sendError(req, res, transportError('UNAUTHENTICATED'));
      return;
    }

    if (isAsset) {
      if (url.search.length > 0) {
        sendError(req, res, badRequest());
        return;
      }
      // Comparaison à une table close : la route n'est jamais un chemin.
      const asset = await loadCockpitAsset(url.pathname);
      if (asset === undefined) {
        sendError(req, res, transportError('NOT_FOUND'));
        return;
      }
      send(req, res, 200, asset.contentType, asset.body);
      return;
    }

    await routeApi(req, res, url);
  }

  /** `POST /api/runs` et `POST /api/runs/:id/{pause|resume|decide|stop|step|send}`. */
  async function routeMutation(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const segments = url.pathname.split('/').slice(2);
    const runService = options.runService;
    const store = options.operations;

    // Création : une route de collection, exactement celle de la V0.2 §19.5.
    // Aucun alias — ni `/start`, ni `/api/start`, ni `/api/runs/start`.
    if (segments[0] === 'runs' && segments.length === 1 && url.search.length === 0) {
      await routeStart(req, res);
      return;
    }

    // Reprise : `runs/:id/recovery/:capability`. La capacité est un segment,
    // et la table est close — tout autre segment est une route inconnue.
    if (segments[0] === 'runs' && segments.length === 4 && segments[2] === 'recovery' && url.search.length === 0) {
      await routeRecovery(req, res, segments[1] ?? '', segments[3] ?? '');
      return;
    }

    // Reprise native : `runs/:id/recovery`, contrat `domaine × geste`. Elle
    // precede la table des mutations courtes, dont `recovery` ne fait pas
    // partie — sans quoi la route serait une simple inconnue.
    if (
      segments[0] === 'runs' &&
      segments.length === 3 &&
      segments[2] === 'recovery' &&
      url.search.length === 0
    ) {
      await routeNativeRecovery(req, res, segments[1] ?? '');
      return;
    }

    // Controverses V3 : `runs/:id/controversies`, union fermée d'opérations.
    // Elle précède la table des mutations courtes, dont ce segment ne fait pas
    // partie — sans quoi la route serait une simple inconnue.
    if (
      segments[0] === 'runs' &&
      segments.length === 3 &&
      segments[2] === CONTROVERSY_MUTATION_ROUTE_SEGMENT &&
      url.search.length === 0
    ) {
      await routeControversyMutation(req, res, segments[1] ?? '');
      return;
    }

    // Preuves V4 : `runs/:id/evidence`, union fermée d'opérations. Même
    // précédence, et pour la même raison que ses deux voisines.
    if (
      segments[0] === 'runs' &&
      segments.length === 3 &&
      segments[2] === EVIDENCE_MUTATION_ROUTE_SEGMENT &&
      url.search.length === 0
    ) {
      await routeEvidenceMutation(req, res, segments[1] ?? '');
      return;
    }

    // Réconciliation V5 : `runs/:id/reconciliations`, union fermée d'opérations.
    // Même précédence, et pour la même raison : ce segment n'appartient pas à la
    // table des mutations courtes, sans quoi la route serait une inconnue.
    if (
      segments[0] === 'runs' &&
      segments.length === 3 &&
      segments[2] === RECONCILIATION_MUTATION_ROUTE_SEGMENT &&
      url.search.length === 0
    ) {
      await routeReconciliationMutation(req, res, segments[1] ?? '');
      return;
    }

    if (segments[0] !== 'runs' || segments.length !== 3 || url.search.length > 0) {
      sendError(req, res, transportError('NOT_FOUND'));
      return;
    }
    if (runService === undefined || store === undefined) {
      sendError(req, res, transportError('INTERNAL_ERROR'));
      return;
    }

    const runId = parseRunIdSegment(segments[1] ?? '');
    if (runId === undefined) {
      sendError(req, res, badRequest());
      return;
    }

    const segment = segments[2] ?? '';
    const manager = options.manager;

    try {
      const body = await readBoundedBody(req, MAX_REQUEST_BODY_BYTES);
      // La génération d'abord, et depuis les faits persistés : « claude » ne
      // désigne pas la même chose dans les deux mondes, et un DTO ne peut pas
      // trancher pour le run.
      const request = {
        routeSegment: segment,
        runId,
        generation: await readRunGeneration(options.dataRoot.runsDir, runId),
        contentType: req.headers['content-type'],
        idempotencyKey: readIdempotencyKey(req),
        body,
      };
      const shared = {
        runService,
        store,
        ...(options.seams === undefined ? {} : { seams: options.seams }),
      };

      // Opérations longues et mutations courtes ne partagent que la validation
      // et l'idempotence : les premières réservent un créneau et rendent `202`.
      const result =
        LONG_MUTATION_ROUTES[segment] !== undefined && manager !== undefined
          ? await executeLongMutation(
              {
                ...shared,
                manager,
                ...(options.longHooks === undefined ? {} : { longHooks: options.longHooks }),
              },
              request,
            )
          : await executeShortMutation(shared, request);
      sendJson(req, res, result.status, result.body);
    } catch (error) {
      sendError(req, res, publicErrorFor(error));
    }
  }

  /**
   * `POST /api/runs/:id/controversies` — écritures V3.
   *
   * Même composition que les autres mutations, et surtout **derrière la même
   * frontière** : session, origine et méthode sont vérifiées avant tout routage,
   * dans `handle`. Une route ajoutée ici hérite donc de ces protections par
   * construction, plutôt que de les redemander.
   *
   * Aucun `manager` : une opération V3 est courte et n'appelle aucun
   * fournisseur. Ne pas en exiger un est la preuve, au niveau de la
   * composition, qu'aucun créneau d'opération longue n'est réservé.
   */
  async function routeControversyMutation(
    req: IncomingMessage,
    res: ServerResponse,
    runSegment: string,
  ): Promise<void> {
    const runService = options.runService;
    const store = options.operations;
    if (runService === undefined || store === undefined) {
      sendError(req, res, transportError('NOT_FOUND'));
      return;
    }
    const runId = parseRunIdSegment(runSegment);
    if (runId === undefined) {
      sendError(req, res, badRequest());
      return;
    }
    try {
      const body = await readBoundedBody(req, MAX_REQUEST_BODY_BYTES);
      const result = await executeControversyMutation(
        { runService, store },
        {
          routeSegment: CONTROVERSY_MUTATION_ROUTE_SEGMENT,
          runId,
          generation: await readRunGeneration(options.dataRoot.runsDir, runId),
          contentType: req.headers['content-type'],
          idempotencyKey: readIdempotencyKey(req),
          body,
        },
      );
      sendJson(req, res, result.status, result.body);
    } catch (error) {
      sendError(req, res, publicErrorFor(error));
    }
  }

  /**
   * `POST /api/runs/:id/evidence` — écritures V4 (V5.1, addendum V3/V4 §7).
   *
   * Aucun `manager` : les deux opérations V4 sont courtes et n'appellent aucun
   * fournisseur. Ne pas en exiger un est la preuve, au niveau de la composition,
   * qu'aucun créneau d'opération longue n'est réservé depuis ici.
   */
  async function routeEvidenceMutation(
    req: IncomingMessage,
    res: ServerResponse,
    runSegment: string,
  ): Promise<void> {
    const runService = options.runService;
    const store = options.operations;
    if (runService === undefined || store === undefined) {
      sendError(req, res, transportError('NOT_FOUND'));
      return;
    }
    const runId = parseRunIdSegment(runSegment);
    if (runId === undefined) {
      sendError(req, res, badRequest());
      return;
    }
    try {
      const body = await readBoundedBody(req, MAX_REQUEST_BODY_BYTES);
      const result = await executeEvidenceMutation(
        { runService, store },
        {
          routeSegment: EVIDENCE_MUTATION_ROUTE_SEGMENT,
          runId,
          generation: await readRunGeneration(options.dataRoot.runsDir, runId),
          contentType: req.headers['content-type'],
          idempotencyKey: readIdempotencyKey(req),
          body,
        },
      );
      sendJson(req, res, result.status, result.body);
    } catch (error) {
      sendError(req, res, publicErrorFor(error));
    }
  }

  /**
   * `POST /api/runs/:id/reconciliations` — écritures V5 (V5.1, addendum §17).
   *
   * Même composition et même frontière que les autres mutations : session,
   * origine et méthode sont vérifiées avant tout routage, dans `handle`.
   *
   * Le `manager` est transmis **s'il existe**. Les deux opérations humaines
   * n'en ont pas besoin ; la proposition assistée, elle, réserve un créneau du
   * moteur d'opérations longues existant, et n'en crée aucun second.
   */
  async function routeReconciliationMutation(
    req: IncomingMessage,
    res: ServerResponse,
    runSegment: string,
  ): Promise<void> {
    const runService = options.runService;
    const store = options.operations;
    if (runService === undefined || store === undefined) {
      sendError(req, res, transportError('NOT_FOUND'));
      return;
    }
    const runId = parseRunIdSegment(runSegment);
    if (runId === undefined) {
      sendError(req, res, badRequest());
      return;
    }
    try {
      const body = await readBoundedBody(req, MAX_REQUEST_BODY_BYTES);
      const result = await executeReconciliationMutation(
        {
          runService,
          store,
          ...(options.manager === undefined ? {} : { manager: options.manager }),
        },
        {
          routeSegment: RECONCILIATION_MUTATION_ROUTE_SEGMENT,
          runId,
          generation: await readRunGeneration(options.dataRoot.runsDir, runId),
          contentType: req.headers['content-type'],
          idempotencyKey: readIdempotencyKey(req),
          body,
        },
      );
      sendJson(req, res, result.status, result.body);
    } catch (error) {
      sendError(req, res, publicErrorFor(error));
    }
  }

  /** `POST /api/runs/:id/recovery` — reprise native, domaine et geste nommes. */
  async function routeNativeRecovery(
    req: IncomingMessage,
    res: ServerResponse,
    runSegment: string,
  ): Promise<void> {
    const runService = options.runService;
    const store = options.operations;
    const manager = options.manager;
    if (runService === undefined || store === undefined || manager === undefined) {
      sendError(req, res, transportError('NOT_FOUND'));
      return;
    }
    const runId = parseRunIdSegment(runSegment);
    if (runId === undefined) {
      sendError(req, res, badRequest());
      return;
    }
    try {
      const body = await readBoundedBody(req, MAX_REQUEST_BODY_BYTES);
      const result = await executeNativeRecoveryMutation(
        { runService, store, manager },
        {
          routeSegment: 'recovery',
          runId,
          generation: await readRunGeneration(options.dataRoot.runsDir, runId),
          contentType: req.headers['content-type'],
          idempotencyKey: readIdempotencyKey(req),
          body,
        },
      );
      sendJson(req, res, result.status, result.body);
    } catch (error) {
      sendError(req, res, publicErrorFor(error));
    }
  }

  /** `POST /api/runs/:id/recovery/:capability` — les cinq intentions de reprise. */
  async function routeRecovery(
    req: IncomingMessage,
    res: ServerResponse,
    runSegment: string,
    capabilitySegment: string,
  ): Promise<void> {
    const runService = options.runService;
    const store = options.operations;
    const manager = options.manager;
    if (runService === undefined || store === undefined || manager === undefined) {
      sendError(req, res, transportError('NOT_FOUND'));
      return;
    }
    const runId = parseRunIdSegment(runSegment);
    if (runId === undefined || RECOVERY_ROUTES[capabilitySegment] === undefined) {
      sendError(req, res, transportError('NOT_FOUND'));
      return;
    }
    try {
      const body = await readBoundedBody(req, MAX_REQUEST_BODY_BYTES);
      const result = await executeRecoveryMutation(
        {
          runService,
          store,
          manager,
          ...(options.seams === undefined ? {} : { seams: options.seams }),
          ...(options.recoveryHooks === undefined ? {} : { recoveryHooks: options.recoveryHooks }),
        },
        {
          routeSegment: capabilitySegment,
          runId,
          generation: await readRunGeneration(options.dataRoot.runsDir, runId),
          contentType: req.headers['content-type'],
          idempotencyKey: readIdempotencyKey(req),
          body,
        },
      );
      sendJson(req, res, result.status, result.body);
    } catch (error) {
      sendError(req, res, publicErrorFor(error));
    }
  }

  /** `POST /api/runs` — création d'un run. */
  async function routeStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const store = options.operations;
    const manager = options.manager;
    const createRunServiceDeps = options.createRunServiceDeps;
    if (store === undefined || manager === undefined || createRunServiceDeps === undefined) {
      sendError(req, res, transportError('NOT_FOUND'));
      return;
    }
    try {
      const body = await readBoundedBody(req, MAX_REQUEST_BODY_BYTES);
      const result = await executeStartMutation(
        {
          store,
          manager,
          createRunServiceDeps,
          ...(options.preflightSeams === undefined ? {} : { preflightSeams: options.preflightSeams }),
          ...(options.startHooks === undefined ? {} : { startHooks: options.startHooks }),
        },
        {
          contentType: req.headers['content-type'],
          idempotencyKey: readIdempotencyKey(req),
          body,
        },
      );
      sendJson(req, res, result.status, result.body);
    } catch (error) {
      sendError(req, res, publicErrorFor(error));
    }
  }

  async function routeApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    // `['', 'api', …]` : le premier segment est toujours vide.
    const segments = url.pathname.split('/').slice(2);
    const deps = options.readModel;

    try {
      if (segments.length === 1 && segments[0] === 'config') {
        if (rejectUnknownParams(url, [])) {
          sendError(req, res, badRequest());
          return;
        }
        sendJson(req, res, 200, await configProjection(options));
        return;
      }

      if (segments.length === 1 && segments[0] === 'doctor') {
        if (rejectUnknownParams(url, [])) {
          sendError(req, res, badRequest());
          return;
        }
        sendJson(req, res, 200, doctorProjection(await doctor()));
        return;
      }

      if (segments.length === 2 && segments[0] === 'operations') {
        if (rejectUnknownParams(url, [])) {
          sendError(req, res, badRequest());
          return;
        }
        const raw = segments[1] ?? '';
        const decoded = decodeSegment(raw);
        // Validation stricte avant tout contact avec le système de fichiers :
        // l'identifiant n'est jamais un chemin, et n'est décodé qu'une fois.
        if (decoded === undefined || !isOperationId(decoded)) {
          sendError(req, res, badRequest());
          return;
        }
        const store = options.operations;
        const receipt = store === undefined ? undefined : await store.read(decoded);
        if (receipt === undefined) {
          sendError(req, res, publicErrorFor(new CcrError('OPERATION_NOT_FOUND', 'Opération inconnue.')));
          return;
        }
        // Une opération dont le reçu terminal n'a pas pu être écrit est
        // incertaine, même pour l'instance qui l'a exécutée : continuer à
        // annoncer `RUNNING` serait un mensonge de plus en plus faux.
        const uncertain = options.manager?.isUncertain(decoded) === true;
        sendJson(req, res, 200, uncertain
          ? { ...toPublicReceipt(receipt), status: 'UNKNOWN' }
          : toPublicReceipt(receipt));
        return;
      }

      if (segments.length === 1 && segments[0] === 'stream') {
        if (rejectUnknownParams(url, [])) {
          sendError(req, res, badRequest());
          return;
        }
        openInvalidationStream(req, res, hub, { kind: 'list' }, nowOf(options));
        return;
      }

      if (segments[0] !== 'runs') {
        sendError(req, res, transportError('NOT_FOUND'));
        return;
      }

      if (segments.length === 1) {
        if (rejectUnknownParams(url, [])) {
          sendError(req, res, badRequest());
          return;
        }
        // `start_effect` (V2.3-S4) — champ **voisin**, strictement additif.
        //
        // L'écran de création existe avant tout run : il ne peut consommer
        // aucune vue de run. Le fait voyage donc sur la collection dont la
        // création est le `POST`, et il est **demandé à la primitive**, jamais
        // réécrit ici. Aucune table d'effet ne vit dans cette projection.
        sendJson(req, res, 200, {
          runs: await listCockpitRuns(deps),
          start_effect: operationEffect('START'),
        });
        return;
      }

      const rawRunId = segments[1];
      if (rawRunId === undefined) {
        sendError(req, res, transportError('NOT_FOUND'));
        return;
      }
      const runId = parseRunIdSegment(rawRunId);
      if (runId === undefined) {
        // Identifiant non canonique : refus **avant** toute lecture disque.
        sendError(req, res, badRequest());
        return;
      }

      // La génération est établie depuis les faits persistés du run, **avant**
      // toute interprétation de vue : les deux modèles ne partagent ni clés ni
      // identités, et un lecteur historique refuse un manifest schema 2.
      //
      // Résolue paresseusement : les routes qui n'en dépendent pas — le flux
      // d'invalidation, générationnellement neutre — ne doivent pas changer de
      // comportement pour un run absent.
      const isNative = async (): Promise<boolean> =>
        (await readRunGeneration(deps.runsDir, runId)) === 'NATIVE_V21_EXECUTION';
      const nativeDeps = {
        runsDir: deps.runsDir,
        ...(deps.settings.maxTransferBytes === undefined
          ? {}
          : { maxTransferBytes: deps.settings.maxTransferBytes }),
      };

      if (segments.length === 2) {
        if (rejectUnknownParams(url, [])) {
          sendError(req, res, badRequest());
          return;
        }
        sendJson(
          req,
          res,
          200,
          (await isNative())
            ? await readNativeRunHttpView(nativeDeps, runId)
            : await getRunView(deps, runId),
        );
        return;
      }

      if (segments.length === 3 && segments[2] === 'timeline') {
        const query = parseTimelineQuery(url);
        if (query === undefined) {
          sendError(req, res, badRequest());
          return;
        }
        // V2.1-IMP-19 : deux projections, une seule surface. La generation est
        // etablie avant toute lecture d'evenement — un evenement natif porte
        // des ExpertSlots, un evenement historique un `target: AgentKind`, et
        // aucun des deux lecteurs ne sait interpreter l'autre.
        sendJson(
          req,
          res,
          200,
          (await isNative())
            ? await readNativeTimelineHttpView(nativeDeps, runId, query)
            : await getTimeline(deps, runId, query),
        );
        return;
      }

      if (segments.length === 3 && segments[2] === 'recovery') {
        if (rejectUnknownParams(url, [])) {
          sendError(req, res, badRequest());
          return;
        }
        sendJson(
          req,
          res,
          200,
          (await isNative())
            ? await readNativeRecoveryHttpView(nativeDeps, runId)
            : await getRecoveryView(deps, runId),
        );
        return;
      }

      if (segments.length === 3 && segments[2] === 'stream') {
        if (rejectUnknownParams(url, [])) {
          sendError(req, res, badRequest());
          return;
        }
        openInvalidationStream(req, res, hub, { kind: 'run', runId }, nowOf(options));
        return;
      }

      sendError(req, res, transportError('NOT_FOUND'));
    } catch (error) {
      sendError(req, res, publicErrorFor(error));
    }
  }

  /**
   * Observateur des écritures externes.
   *
   * Il ne tourne que lorsqu'au moins un flux est ouvert : sans client, aucune
   * minuterie, aucune surveillance, aucun accès disque.
   */
  const hub: InvalidationHub = createInvalidationHub({
    runsDir: options.dataRoot.runsDir,
    ...(options.reconciliationIntervalMs === undefined ? {} : { intervalMs: options.reconciliationIntervalMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.onReconciled === undefined ? {} : { onReconciled: options.onReconciled }),
  });

  /** Horloge du serveur — injectable pour les preuves, `Date` sinon. */
  function nowOf(current: CockpitServerOptions): () => Date {
    return current.now ?? ((): Date => new Date());
  }

  // Le port observé est la source de l'allowlist ; il est publié après bind.
  server.on('listening', () => {
    const address = server.address();
    if (address !== null && typeof address !== 'string') boundPort = address.port;
  });

  // L'observateur appartient au serveur : il s'arrête avec lui, et jamais
  // depuis ailleurs.
  observers.set(server, hub);
  return server;
}

/**
 * Ouvre le socket loopback.
 *
 * Un échec de bind est fatal et explicite : aucun repli sur une autre adresse,
 * aucune allocation magique d'un autre port (§25.2).
 */
export async function startCockpitHttpServer(
  options: CockpitServerOptions,
): Promise<RunningCockpitServer> {
  const sessionSecret = options.sessionSecret ?? createSessionSecret();
  const server = createCockpitServer(options, sessionSecret);
  const port = options.port ?? DEFAULT_COCKPIT_PORT;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      reject(
        new CcrError(
          'COCKPIT_BIND_FAILED',
          `Impossible d'ouvrir ${COCKPIT_BIND_ADDRESS}:${String(port)} (${error.code ?? 'inconnu'}).`,
          { details: { address: COCKPIT_BIND_ADDRESS, port, code: error.code ?? null } },
        ),
      );
    };
    server.once('error', onError);
    server.listen({ host: COCKPIT_BIND_ADDRESS, port }, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    url: `http://${COCKPIT_BIND_ADDRESS}:${String(address.port)}/`,
    port: address.port,
    address: address.address,
    sessionSecret,
    dropConnections: () => server.closeAllConnections(),
    close: () =>
      new Promise<void>((resolve) => {
        // L'observation s'arrête avant les sockets : un flux fermé sans
        // observateur vivant ne peut plus rien émettre, et rien ne retient la
        // boucle d'événements.
        observers.get(server)?.stop();
        server.close(() => {
          resolve();
        });
        // Les connexions gardées ouvertes ne doivent pas retarder l'arrêt.
        server.closeAllConnections();
      }),
  };
}
