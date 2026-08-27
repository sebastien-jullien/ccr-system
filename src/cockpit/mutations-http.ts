/**
 * Mutations courtes — couche HTTP (V0.2 §19, §23, §25.5 ; V2-IMP-37).
 *
 * ## Ordre normatif, et pourquoi il est gelé
 *
 * ```text
 *  1 Host canonique                        (serveur)
 *  2 session valide                        (serveur)
 *  3 Origin exact                          (serveur)
 *  4 route et méthode                      (serveur)
 *  5 borne de corps                        (serveur)
 *  6 Content-Type
 *  7 parsing JSON
 *  8 schéma + Idempotency-Key
 *  9 normalisation et empreinte
 * 10 claim durable
 * 11 préconditions métier    ┐ même run lock
 * 12 expected_revision       ┘
 * 13 effet V1
 * 14 reçu terminal
 * 15 réponse
 * ```
 *
 * Le claim précède les préconditions **délibérément**. Conséquence assumée :
 * un `STALE_REVISION` produit un reçu terminal d'échec. C'est ce qui garantit
 * qu'une retransmission de la *même* tentative ne devienne pas un succès
 * simplement parce que le run a changé entre-temps : la tentative avait été
 * décidée sur une vue donnée, et cette vue n'existe plus.
 *
 * ## Ce que cette couche ne fait pas
 *
 * Aucune règle métier. Elle valide une requête, garantit l'unicité de l'effet,
 * puis délègue à la composition qui tient le verrou. Elle ne connaît ni les
 * gardes, ni les transitions, ni les événements.
 */

import { createHash } from 'node:crypto';

import path from 'node:path';

import { CcrError, isCcrError } from '../core/errors.ts';
import type { CcrErrorCode } from '../core/errors.ts';
import { publicErrorFor } from './http-errors.ts';
import { isRunId } from '../core/ids.ts';
import { applyShortMutation, SHORT_MUTATION_ACTIONS } from '../services/short-mutations.ts';
import { applyLongMutation } from '../services/long-mutations.ts';
import { applyStartMutation } from '../services/start-mutation.ts';
import { applyCanonicalRecovery } from '../services/recovery-application-service.ts';
import type { CanonicalRecoveryHooks } from '../services/recovery-application-service.ts';
import { clearStaleRunLock } from '../services/clear-stale-run-lock-service.ts';
import type { ClearStaleRunLockHooks } from '../services/clear-stale-run-lock-service.ts';
import { isLockToken } from '../lock/lock-token.ts';
import type { CanonicalRecoveryCapabilityId, RecoveryCapabilityId } from '../services/recovery-planner.ts';
import type { StartMutationHooks } from '../services/start-mutation.ts';
import type { StartPreflightSeams } from '../services/start-application-service.ts';
import type { LongMutationAction, LongMutationHooks } from '../services/long-mutations.ts';
import type { LongOperationManager } from './long-operations.ts';
import type { AgentKind } from '../core/run.ts';
import type { ShortMutationAction, ShortMutationSeams } from '../services/short-mutations.ts';
import type { RunRuntimeSettings, RunServiceDeps } from '../services/run-service.ts';
import {
  applyNativeLongMutation,
  applyNativeShortMutation,
  applyNativeStartMutation,
} from '../services/native-mutations.ts';
import { parseNativeExpertTargetRef } from '../services/native-target-resolver.ts';
import { applyNativeRecoveryMutation } from '../services/native-recovery-mutations.ts';
import {
  isNativeRecoveryDomain,
  isSupportedPair,
  nativeRecoveryActionOf,
  requiresNote,
  slugsOf,
  unsupportedPairError,
  NATIVE_RECOVERY_ACTION_SLUGS,
  NATIVE_RECOVERY_DOMAINS,
} from '../services/native-recovery-dispatch.ts';
import type { NativeRecoveryDomain } from '../services/native-recovery-dispatch.ts';
import type { NativeRecoveryActionId } from '../services/native-read-model.ts';
import { isExpertSlotId, isProviderKind } from '../core/expert.ts';
import type { ProviderKind } from '../core/expert.ts';
import { RELATION_ACTS } from '../core/controversy.ts';
import {
  MAX_CONTROVERSY_TEXT_BYTES,
  confirmInferredRelation,
  contestInferredRelation,
  recordAssertion,
  recordControversy,
  recordHumanAuthority,
  recordHumanTranscription,
  recordNature,
  recordRelation,
} from '../services/controversy-service.ts';
import type {
  ControversyMutationResult,
  ControversyServiceDeps,
} from '../services/controversy-service.ts';
import { adduceMaterial, registerMaterial } from '../services/evidence-service.ts';
import {
  recordProposalResponse,
  recordReconciliation,
} from '../services/reconciliation-service.ts';
import { requestModelReconciliationProposal } from '../services/reconciliation-proposer.ts';
import type { PublicReconciliationProposalOutcome } from '../services/reconciliation-proposer.ts';
import type { RunExecutionMode } from '../store/run-directory.ts';
import {
  computeFingerprint,
  digestOfContent,
  toPublicReceipt,
} from './operations-store.ts';
import type {
  OperationDomainOutcome,
  OperationReceipt,
  OperationStore,
  PublicOperationReceipt,
} from './operations-store.ts';

/** Bornes reprises de V0.2 §23.3. Aucun corps n'est jamais tronqué. */
export const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
export const MAX_DECISION_CONTENT_BYTES = 256 * 1024;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

/** Segment de route → action. Table close : rien d'autre n'est mutable. */
export const SHORT_MUTATION_ROUTES: Readonly<Record<string, ShortMutationAction>> = {
  pause: 'PAUSE',
  resume: 'RESUME',
  decide: 'DECIDE',
  stop: 'STOP',
};

const REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/;
const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,200}$/;

export interface MutationRequest {
  readonly routeSegment: string;
  readonly runId: string;
  /**
   * Generation du run vise, etablie depuis ses faits persistes (V2.1-IMP-17C).
   *
   * Portee par la requete parce qu'elle doit etre connue **avant** toute
   * interpretation de cible : « claude » nomme un agent dans un run historique
   * et un moteur dans un run natif, et le mot ne peut pas trancher pour le run.
   */
  readonly generation: RunExecutionMode;
  readonly contentType: string | undefined;
  readonly idempotencyKey: string | undefined;
  readonly body: string;
}

/** Refus d'une surface non portee a la generation du run vise. */
function unsupportedForGeneration(command: string, runId: string): CcrError {
  return new CcrError(
    'COMMAND_UNSUPPORTED_FOR_GENERATION',
    `\`${command}\` n'est pas portee aux runs natifs en V2.1. Le run vise est ${runId}.`,
    { details: { command, runId, execution_mode: 'NATIVE_V21_EXECUTION' } },
  );
}

export interface MutationDeps {
  readonly runService: RunServiceDeps;
  readonly store: OperationStore;
  readonly seams?: ShortMutationSeams;
}

export interface MutationResponse {
  readonly status: number;
  /** Reçu public, ou enveloppe d'erreur augmentée de l'`operation_id`. */
  readonly body: unknown;
  readonly receipt: PublicOperationReceipt;
}

/**
 * Réponse dérivée d'un reçu.
 *
 * Un échec métier déterministe conserve **les deux** exigences : le statut HTTP
 * qui décrit la situation — `409` pour une vue périmée — et un reçu terminal
 * durable. La retransmission rend exactement la même chose, sans réévaluer.
 */
function respondFor(receipt: PublicOperationReceipt): MutationResponse {
  if (receipt.status !== 'FAILED') return { status: 200, body: receipt, receipt };
  const mapped = publicErrorFor(new CcrError((receipt.error_code ?? 'INTERNAL_ERROR') as CcrErrorCode, ''));
  return {
    status: mapped.status,
    // Champ additionnel nommé explicitement (§24.2) : il permet de retrouver le
    // reçu sans exposer quoi que ce soit d'interne.
    body: { ...mapped.body, operation_id: receipt.operation_id },
    receipt,
  };
}

function invalid(message: string): CcrError {
  return new CcrError('INVALID_ARGUMENT', message);
}

/**
 * Vérifie l'origine d'une mutation (§25.5).
 *
 * `SameSite=Strict` ne remplace pas ce contrôle : il dépend du comportement du
 * navigateur, là où cette vérification dépend de nous. `Referer`,
 * `X-Forwarded-Host` et `X-Forwarded-Proto` ne sont jamais consultés — il
 * n'existe aucun proxy inverse dans le produit.
 */
export function assertCanonicalOrigin(origin: string | undefined, canonical: string): void {
  if (origin === canonical) return;
  throw new CcrError(
    'INVALID_ORIGIN',
    "L'origine de cette requête n'est pas celle du cockpit. Aucune action n'a été effectuée.",
    { details: { expected: canonical } },
  );
}

interface ValidatedPayload {
  readonly expectedRevision: string;
  readonly content?: string;
}

/**
 * Valide le corps d'une mutation.
 *
 * La normalisation se fait par **extraction de champs validés**, pas par
 * re-sérialisation du JSON reçu : l'ordre des propriétés du client n'a donc
 * aucune influence sur l'empreinte, par construction plutôt que par tri.
 */
function validatePayload(action: ShortMutationAction, body: string): ValidatedPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw invalid('Corps JSON illisible.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalid('Le corps doit être un objet JSON.');
  }
  const candidate = parsed as Record<string, unknown>;

  const allowed = action === 'DECIDE' ? ['expected_revision', 'content'] : ['expected_revision'];
  for (const key of Object.keys(candidate)) {
    if (!allowed.includes(key)) throw invalid(`Champ inattendu : ${key}.`);
  }

  const revision = candidate['expected_revision'];
  if (typeof revision !== 'string' || !REVISION_PATTERN.test(revision)) {
    throw invalid('`expected_revision` absente ou mal formée.');
  }

  if (action !== 'DECIDE') return { expectedRevision: revision };

  const content = candidate['content'];
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw invalid('Une décision ne peut pas être vide.');
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_DECISION_CONTENT_BYTES) {
    throw new CcrError('PAYLOAD_TOO_LARGE', 'Décision trop volumineuse.');
  }
  return { expectedRevision: revision, content };
}

function validateKey(key: string | undefined): string {
  if (key === undefined || !KEY_PATTERN.test(key) || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    // La clé elle-même n'est jamais reprise dans le message : opaque, et
    // potentiellement porteuse d'information côté client.
    throw invalid('En-tête `Idempotency-Key` absent ou mal formé.');
  }
  return key;
}

function assertJsonContentType(contentType: string | undefined): void {
  const base = (contentType ?? '').split(';')[0]?.trim().toLowerCase();
  if (base !== 'application/json') {
    throw new CcrError('UNSUPPORTED_MEDIA_TYPE', 'Les mutations attendent `application/json`.');
  }
}

/**
 * Codes métier qui décrivent un refus **déterministe**.
 *
 * Un reçu terminal `FAILED` les porte, et une retransmission de la même clé
 * rend ce même refus sans réévaluer quoi que ce soit : la tentative a été
 * jugée une fois, sur une vue donnée.
 *
 * Le critère d'appartenance n'est pas « l'erreur se reproduira », mais
 * « l'effet est connu, et il vaut zéro ». Un refus dont on ne peut pas
 * l'affirmer laisse le reçu `RUNNING`, qui deviendra `UNKNOWN` après un
 * redémarrage — mentir en le terminalisant serait pire que ne rien dire.
 */
const DETERMINISTIC_FAILURES = new Set([
  'STALE_REVISION',
  'RECOVERY_REQUIRED',
  'RUN_NOT_PAUSABLE',
  'RUN_NOT_RESUMABLE',
  'ILLEGAL_STATE_TRANSITION',
  'INVALID_ARGUMENT',
  'RUN_NOT_FOUND',
  'MANIFEST_INVALID',
  'STATE_INVALID',
  'JOURNAL_INVALID',
  'SCHEMA_VERSION_UNSUPPORTED',
  'SESSION_MISSING',
  'AUTOMATION_NOT_IN_CONTROL',
  // Reprise : chacun de ces trois refus est constaté avant tout effet.
  'RECOVERY_CAPABILITY_STALE',
  'RECOVERY_LOCK_CHANGED',
  'RECOVERY_LOCK_NOT_CLEARABLE',
  // V2.1-IMP-17C : refus natifs constates avant tout effet et tout fournisseur.
  // Chacun est leve par une garde ou un resolveur pur, sous le verrou, avant le
  // premier fait durable — leur terminalisation ne ment donc sur rien.
  'AMBIGUOUS_PROVIDER_ALIAS',
  'PROVIDER_ALIAS_NOT_BOUND',
  'SOURCE_NOT_REPLAYABLE',
  'SOURCE_STALE_AFTER_HANDOFF',
  'SOURCE_ALREADY_TRANSFERRED',
  'NO_TRANSFERABLE_SOURCE',
  'RECOVERY_EVIDENCE_CONFLICT',
  'COMMAND_UNSUPPORTED_FOR_GENERATION',
  'HANDOFF_NOT_ALLOWED',
  /**
   * V5.1 — contexte de proposition au-delà de la borne.
   *
   * Constaté en phase A, avant le quota, avant l'`invocation_id`, avant le
   * ledger et avant tout adaptateur. Aucun effet métier n'a pu avoir lieu, si
   * bien que terminaliser le reçu de transport en échec ne ment sur rien.
   *
   * Ce reçu **n'est pas** une écriture métier V5 : il dit ce que la requête est
   * devenue, jamais ce que le run est devenu — et le run, lui, n'a pas bougé.
   */
  'PROPOSAL_CONTEXT_TOO_LARGE',
  /**
   * Verrou de run occupé (amendement V2-IMP-41).
   *
   * Ajouté après cartographie, pas par ressemblance. Ce code n'a qu'un seul
   * site de construction — `conflictError`, dans `src/lock/run-lock.ts` — et il
   * n'est atteint que depuis la branche `EEXIST` de `acquireRunLock`,
   * c'est-à-dire avant que la callback gardée existe. Aucun chemin ne peut donc
   * l'émettre après un effet.
   *
   * Le seul appelant qui produise quelque chose *avant* de verrouiller est
   * `startRun`, qui alloue son répertoire puis prend le verrou — mais ce
   * répertoire vient d'être créé par `mkdir` non récursif, il est vide, et
   * aucun verrou ne peut y préexister. Le cas est structurellement inatteignable,
   * pas seulement improbable.
   *
   * Laisser ce refus en `RUNNING` affirmait donc quelque chose de faux : que
   * l'effet était peut-être en cours, alors qu'il n'avait pas commencé.
   *
   * `STALE_LOCK` l'accompagne parce que c'est le **même refus**. Les deux codes
   * sortent du même `conflictError`, choisis par le seul `assessLiveness` : le
   * propriétaire est mort, ou il ne l'est pas. `clearStaleLock` atteint bien
   * `conflictError`, mais uniquement lorsque la vivacité n'est pas `STALE` — il
   * ne peut donc produire que l'autre code.
   *
   * Les séparer coupait le même geste humain — agir sur un run occupé — en deux
   * comportements que rien ne distingue pour qui l'accomplit : reçu terminal et
   * clé réutilisable si le détenteur vit, reçu `RUNNING` perpétuel et clé
   * consommée s'il est mort. C'est le cas mort qui est le plus fréquent sur le
   * terrain, puisqu'il survit à un arrêt brutal.
   */
  'RUN_ALREADY_LOCKED',
  'STALE_LOCK',
]);

export async function executeShortMutation(
  deps: MutationDeps,
  request: MutationRequest,
): Promise<MutationResponse> {
  // 4 — route close.
  const action = SHORT_MUTATION_ROUTES[request.routeSegment];
  if (action === undefined || !SHORT_MUTATION_ACTIONS.includes(action)) {
    throw new CcrError('RUN_NOT_FOUND', 'Route de mutation inconnue.');
  }
  if (!isRunId(request.runId)) throw invalid('Identifiant de run non canonique.');

  // 6, 7, 8 — média, parsing, schéma, clé.
  assertJsonContentType(request.contentType);
  const payload = validatePayload(action, request.body);
  const key = validateKey(request.idempotencyKey);

  // 9 — empreinte d'intention, sur champs validés.
  const fingerprint = computeFingerprint({
    method: 'POST',
    action,
    runId: request.runId,
    expectedRevision: payload.expectedRevision,
    ...(payload.content === undefined ? {} : { contentDigest: digestOfContent(payload.content) }),
  });

  // 10 — claim durable, AVANT toute précondition et tout effet.
  const claim = await deps.store.claim({
    idempotencyKey: key,
    fingerprint,
    runId: request.runId,
    action,
  });

  if (claim.kind === 'EXISTING') {
    // Retransmission : le verdict déjà rendu, quel qu'il soit. Aucun effet,
    // aucune réévaluation — y compris pour un `FAILED` ou un `UNKNOWN`.
    return respondFor(toPublicReceipt(claim.receipt));
  }

  const operationId = claim.receipt.operation_id;

  const native = request.generation === 'NATIVE_V21_EXECUTION';

  try {
    // 11, 12, 13 — préconditions, révision et effet dans un seul run lock.
    // La generation choisit l'application ; ni la validation, ni l'empreinte,
    // ni le recu ne changent.
    const outcome = native
      ? await (async () => {
          if (action !== 'PAUSE' && action !== 'RESUME') {
            // `decide` et `stop` n'ont pas de service natif en V2.1. Le refus
            // est explicite et nomme le run — jamais un detournement vers le
            // moteur historique.
            throw unsupportedForGeneration(action.toLowerCase(), request.runId);
          }
          return applyNativeShortMutation(deps.runService, {
            runId: request.runId,
            action,
            expectedRevision: payload.expectedRevision,
          });
        })()
      : await applyShortMutation(
          deps.runService,
          {
            runId: request.runId,
            action,
            expectedRevision: payload.expectedRevision,
            ...(payload.content === undefined ? {} : { content: payload.content }),
          },
          deps.seams ?? {},
        );

    // 14 — reçu terminal.
    const settled = await deps.store.settle(operationId, {
      status: 'SUCCEEDED',
      revisionAfter: outcome.revisionAfter,
    });
    return respondFor(toPublicReceipt(settled));
  } catch (error) {
    const code = isCcrError(error) ? error.code : 'INTERNAL_ERROR';
    if (!DETERMINISTIC_FAILURES.has(code)) {
      // Échec dont on ne peut pas affirmer qu'il n'a rien fait : le reçu reste
      // `RUNNING` et sera lu `UNKNOWN` après redémarrage. Ne jamais mentir en
      // le terminalisant en échec.
      throw error;
    }
    const settled = await deps.store.settle(operationId, { status: 'FAILED', errorCode: code });
    return respondFor(toPublicReceipt(settled));
  }
}


// --------------------------------------------------------------------------
// Opérations longues — `STEP` et `SEND`
// --------------------------------------------------------------------------

/** Table close des routes longues. Rien d'autre n'appelle un fournisseur. */
export const LONG_MUTATION_ROUTES: Readonly<Record<string, LongMutationAction>> = {
  step: 'STEP',
  send: 'SEND',
};

export const MAX_SEND_CONTENT_BYTES = 256 * 1024;

interface ValidatedLongPayload {
  readonly expectedRevision: string;
  /** Cible **textuelle**, non interpretee : l'union close des deux generations. */
  readonly target?: string;
  readonly content?: string;
}

/** Cible historique : seuls les deux moteurs y ont un sens. */
function legacyTarget(target: string | undefined): AgentKind {
  if (target !== 'claude' && target !== 'codex') {
    throw invalid('Sur un run historique, la cible doit être "claude" ou "codex".');
  }
  return target;
}

/**
 * Valide le corps d'une opération longue.
 *
 * `STEP` ne prend **que** la révision attendue : la source, l'agent cible, la
 * session et l'enveloppe sont déterminés par `planStepTransfer`. Laisser le
 * navigateur choisir une source de transfert lui donnerait une décision qui
 * appartient au cœur.
 */
function validateLongPayload(action: LongMutationAction, body: string): ValidatedLongPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw invalid('Corps JSON illisible.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalid('Le corps doit être un objet JSON.');
  }
  const candidate = parsed as Record<string, unknown>;
  const allowed = action === 'SEND' ? ['expected_revision', 'target', 'content'] : ['expected_revision'];
  for (const key of Object.keys(candidate)) {
    if (!allowed.includes(key)) throw invalid(`Champ inattendu : ${key}.`);
  }

  const revision = candidate['expected_revision'];
  if (typeof revision !== 'string' || !REVISION_PATTERN.test(revision)) {
    throw invalid('`expected_revision` absente ou mal formée.');
  }
  if (action === 'STEP') return { expectedRevision: revision };

  // Validation **syntaxique** seulement : l'union close des deux generations.
  // Ce qu'un mot designe reellement appartient au run, pas au DTO.
  const target = candidate['target'];
  if (target !== 'claude' && target !== 'codex' && target !== 'author' && target !== 'challenger') {
    throw invalid('`target` doit désigner un expert ou un moteur supporté.');
  }
  const content = candidate['content'];
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw invalid('Un message ne peut pas être vide.');
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_SEND_CONTENT_BYTES) {
    throw new CcrError('PAYLOAD_TOO_LARGE', 'Message trop volumineux.');
  }
  return { expectedRevision: revision, target, content };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Une rejection observée plus tard ne doit pas devenir « non gérée ».
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

export interface LongMutationDepsHttp extends MutationDeps {
  readonly manager: LongOperationManager;
  readonly longHooks?: LongMutationHooks;
}

/**
 * Exécute une opération longue.
 *
 * Le `202` est rendu dès l'**admission**, sans attendre le fournisseur : la
 * poignée de main se fait par `onAdmitted`. Ce qui précède — claim, verrou,
 * révision, préconditions, créneau — est donc entièrement accompli quand le
 * client reçoit son accusé, et rien de plus.
 */
export async function executeLongMutation(
  deps: LongMutationDepsHttp,
  request: MutationRequest,
): Promise<MutationResponse> {
  const action = LONG_MUTATION_ROUTES[request.routeSegment];
  if (action === undefined) throw new CcrError('RUN_NOT_FOUND', 'Route de mutation inconnue.');
  if (!isRunId(request.runId)) throw invalid('Identifiant de run non canonique.');

  assertJsonContentType(request.contentType);
  const payload = validateLongPayload(action, request.body);
  const key = validateKey(request.idempotencyKey);

  const fingerprint = computeFingerprint({
    method: 'POST',
    action: payload.target === undefined ? action : `${action}:${payload.target}`,
    runId: request.runId,
    expectedRevision: payload.expectedRevision,
    ...(payload.content === undefined ? {} : { contentDigest: digestOfContent(payload.content) }),
  });

  const claim = await deps.store.claim({
    idempotencyKey: key,
    fingerprint,
    runId: request.runId,
    action,
  });

  if (claim.kind === 'EXISTING') {
    // Retransmission : jamais un second créneau, jamais un second fournisseur.
    const known = deps.manager.isUncertain(claim.receipt.operation_id)
      ? { ...toPublicReceipt(claim.receipt), status: 'UNKNOWN' as const }
      : toPublicReceipt(claim.receipt);
    return respondFor(known);
  }

  const operationId = claim.receipt.operation_id;
  let admitted = false;
  const handshake = deferred<void>();

  const task = (async (): Promise<PublicOperationReceipt | undefined> => {
    try {
      const onAdmitted = (): void => {
        admitted = true;
        handshake.resolve();
      };
      const outcome =
        request.generation === 'NATIVE_V21_EXECUTION'
          ? await applyNativeLongMutation(
              { runService: deps.runService, manager: deps.manager, operationId },
              {
                runId: request.runId,
                action,
                expectedRevision: payload.expectedRevision,
                // La cible est resolue par le resolveur de 2A, jamais par une
                // table provider→slot du transport.
                ...(payload.target === undefined
                  ? {}
                  : { ref: parseNativeExpertTargetRef(payload.target) }),
                ...(payload.content === undefined ? {} : { content: payload.content }),
              },
              { onAdmitted },
            )
          : await applyLongMutation(
              { runService: deps.runService, manager: deps.manager, operationId },
              {
                runId: request.runId,
                action,
                expectedRevision: payload.expectedRevision,
                ...(payload.target === undefined ? {} : { target: legacyTarget(payload.target) }),
                ...(payload.content === undefined ? {} : { content: payload.content }),
              },
              { ...deps.longHooks, onAdmitted },
            );
      return toPublicReceipt(
        await deps.store.settle(operationId, { status: 'SUCCEEDED', revisionAfter: outcome.revisionAfter }),
      );
    } catch (error) {
      if (!admitted) handshake.reject(error);
      const code = isCcrError(error) ? error.code : 'INTERNAL_ERROR';
      const revisionAfter = (error as { revisionAfter?: string }).revisionAfter;
      try {
        return toPublicReceipt(
          await deps.store.settle(operationId, {
            status: 'FAILED',
            errorCode: code,
            ...(revisionAfter === undefined ? {} : { revisionAfter }),
          }),
        );
      } catch {
        // Le reçu terminal n'a pas pu être écrit : l'instance courante ne doit
        // pas continuer à annoncer `RUNNING` pour une tâche qu'elle sait finie.
        deps.manager.markUncertain(operationId);
        return undefined;
      }
    }
  })();

  try {
    // Course délibérée : soit l'admission arrive, soit l'opération se termine
    // avant — cas du garde-fou de taille, qui n'atteint aucun fournisseur.
    const settledEarly = await Promise.race([handshake.promise.then(() => undefined), task]);
    if (settledEarly !== undefined) return respondFor(settledEarly);
    return { status: 202, body: toPublicReceipt(claim.receipt), receipt: toPublicReceipt(claim.receipt) };
  } catch {
    const settled = await task;
    if (settled !== undefined) return respondFor(settled);
    return respondFor({ ...toPublicReceipt(claim.receipt), status: 'UNKNOWN' });
  }
}

/** Condensat utilitaire, pour les tests d'empreinte. */
export function fingerprintOfRequest(input: {
  readonly action: string;
  readonly runId: string;
  readonly expectedRevision: string;
  readonly content?: string;
}): string {
  return computeFingerprint({
    method: 'POST',
    action: input.action,
    runId: input.runId,
    expectedRevision: input.expectedRevision,
    ...(input.content === undefined ? {} : { contentDigest: digestOfContent(input.content) }),
  });
}

/** Condensat d'un corps brut — diagnostic seulement, jamais persisté. */
export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

// --------------------------------------------------------------------------
// START — création d'un run (V2-IMP-39)
// --------------------------------------------------------------------------

export const MAX_START_TITLE_BYTES = 1024;
export const MAX_START_PROMPT_BYTES = 256 * 1024;

interface ValidatedStartPayload {
  readonly title: string;
  /** Normalisé **syntaxiquement** : c'est cette forme qui entre dans l'empreinte. */
  readonly workspaceCwd: string;
  readonly prompt: string;
  /** Moteurs choisis. Absents : les defauts geles de V2.1. */
  readonly authorProvider?: ProviderKind;
  readonly challengerProvider?: ProviderKind;
  /** Limite CCR d'invocations, posée à la naissance du run (`V2.2-IMP-09`). */
  readonly maxInvocations?: number;
}

/**
 * Limite CCR d'invocations du run à créer (`V2.2-IMP-09`).
 *
 * Refusée au transport, avant le preflight et avant toute allocation : une
 * valeur mal formée ne doit pas laisser derrière elle un run que personne n'a
 * demandé. Aucune coercition — la chaîne « 3 » ne vaut pas trois.
 */
function optionalMaxInvocations(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalid(
      '`max_invocations` doit être un entier JSON positif ou nul : le nombre ' +
        "d'appels model-producing que CCR s'autorise sur ce run.",
    );
  }
  return value;
}

function optionalProvider(value: unknown, field: string): ProviderKind | undefined {
  if (value === undefined) return undefined;
  if (!isProviderKind(value)) throw invalid(`\`${field}\` doit valoir "claude" ou "codex".`);
  return value;
}

/**
 * Valide l'intention de création.
 *
 * Trois champs, pas un de plus. Ni rôles, ni drapeaux runtime, ni sélection de
 * fournisseur : ce sont des décisions du cœur ou des valeurs par défaut, et les
 * exposer ici créerait des options produit que rien ne demande.
 *
 * La normalisation du chemin est **syntaxique**. Sa canonicalisation réelle —
 * `realpath`, existence, nature — appartient à la précondition, donc après le
 * claim : un workspace invalide doit laisser un reçu, pas un silence.
 */
function validateStartPayload(body: string): ValidatedStartPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw invalid('Corps JSON illisible.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalid('Le corps doit être un objet JSON.');
  }
  const candidate = parsed as Record<string, unknown>;
  for (const key of Object.keys(candidate)) {
    const allowed = [
      'title',
      'workspace_cwd',
      'prompt',
      'author_provider',
      'challenger_provider',
      'max_invocations',
    ];
    if (!allowed.includes(key)) {
      throw invalid(`Champ inattendu : ${key}.`);
    }
  }

  const title = candidate['title'];
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw invalid('Un titre de run ne peut pas être vide.');
  }
  if (Buffer.byteLength(title, 'utf8') > MAX_START_TITLE_BYTES) {
    throw new CcrError('PAYLOAD_TOO_LARGE', 'Titre trop volumineux.');
  }

  const workspace = candidate['workspace_cwd'];
  if (typeof workspace !== 'string' || workspace.trim().length === 0) {
    throw invalid('Un répertoire de travail est obligatoire.');
  }

  const prompt = candidate['prompt'];
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw invalid('Un contexte initial ne peut pas être vide.');
  }
  if (Buffer.byteLength(prompt, 'utf8') > MAX_START_PROMPT_BYTES) {
    throw new CcrError('PAYLOAD_TOO_LARGE', 'Contexte initial trop volumineux.');
  }

  const authorProvider = optionalProvider(candidate['author_provider'], 'author_provider');
  const challengerProvider = optionalProvider(candidate['challenger_provider'], 'challenger_provider');
  const maxInvocations = optionalMaxInvocations(candidate['max_invocations']);

  return {
    title,
    workspaceCwd: path.normalize(workspace),
    prompt,
    ...(authorProvider === undefined ? {} : { authorProvider }),
    ...(challengerProvider === undefined ? {} : { challengerProvider }),
    ...(maxInvocations === undefined ? {} : { maxInvocations }),
  };
}

export interface StartMutationDepsHttp {
  readonly store: OperationStore;
  readonly manager: LongOperationManager;
  readonly createRunServiceDeps: (runtime: RunRuntimeSettings) => RunServiceDeps;
  readonly preflightSeams?: StartPreflightSeams;
  readonly startHooks?: StartMutationHooks;
}

export interface StartRequest {
  readonly contentType: string | undefined;
  readonly idempotencyKey: string | undefined;
  readonly body: string;
}

/**
 * Exécute `POST /api/runs`.
 *
 * Même forme que les autres opérations longues, à une différence près qui
 * gouverne tout : **le run n'existe pas encore**. Il n'y a donc ni
 * `expected_revision` — aucune vue ne peut être périmée — ni `run_id` au claim.
 * En contrepartie, le `202` n'est rendu qu'une fois le run alloué et son
 * identité durablement inscrite dans le reçu : un client qui perd sa réponse
 * doit pouvoir retrouver ce que son intention a créé.
 */
export async function executeStartMutation(
  deps: StartMutationDepsHttp,
  request: StartRequest,
): Promise<MutationResponse> {
  assertJsonContentType(request.contentType);
  const payload = validateStartPayload(request.body);
  const key = validateKey(request.idempotencyKey);

  // Empreinte d'intention : la méthode, l'action, et le condensat des trois
  // champs normalisés. Ni octets bruts, ni ordre des propriétés, ni cookie, ni
  // configuration effective, ni résultat de probe — et pas de `run_id`, qui
  // n'existe pas encore.
  const fingerprint = computeFingerprint({
    method: 'POST',
    action: 'START',
    contentDigest: digestOfContent(
      [
        payload.workspaceCwd,
        payload.title,
        payload.prompt,
        payload.authorProvider ?? '',
        payload.challengerProvider ?? '',
        // Deux limites différentes ne décrivent pas la même intention.
        payload.maxInvocations === undefined ? '' : String(payload.maxInvocations),
      ].join('\u0000'),
    ),
  });

  const claim = await deps.store.claim({ idempotencyKey: key, fingerprint, action: 'START' });

  if (claim.kind === 'EXISTING') {
    // Retransmission : ni second créneau, ni second preflight, ni second run.
    const known = deps.manager.isUncertain(claim.receipt.operation_id)
      ? { ...toPublicReceipt(claim.receipt), status: 'UNKNOWN' as const }
      : toPublicReceipt(claim.receipt);
    return respondFor(known);
  }

  const operationId = claim.receipt.operation_id;
  let admitted = false;
  let allocated: string | undefined;
  let associated: OperationReceipt | undefined;
  const handshake = deferred<void>();

  const task = (async (): Promise<PublicOperationReceipt | undefined> => {
    try {
      // Toute creation par une surface V2.1 produit un run **natif** : la
      // decision est fermee depuis 2E, et la CLI l'applique deja. Les runs
      // historiques restent operables ; ils ne sont simplement plus crees.
      const outcome = await applyNativeStartMutation(
        {
          createRunServiceDeps: deps.createRunServiceDeps,
          manager: deps.manager,
          operationId,
          ...(deps.preflightSeams === undefined ? {} : { preflightSeams: deps.preflightSeams }),
        },
        {
          title: payload.title,
          workspaceCwd: payload.workspaceCwd,
          prompt: payload.prompt,
          bindings: {
            ...(payload.authorProvider === undefined ? {} : { author: payload.authorProvider }),
            ...(payload.challengerProvider === undefined
              ? {}
              : { challenger: payload.challengerProvider }),
          },
          ...(payload.maxInvocations === undefined ? {} : { maxInvocations: payload.maxInvocations }),
        },
        {
          ...deps.startHooks,
          onAdmitted: (id) => {
            admitted = true;
            deps.startHooks?.onAdmitted?.(id);
          },
          afterAllocation: async (runId) => {
            allocated = runId;
            await deps.startHooks?.afterAllocation?.(runId);
          },
          onRunAllocated: async (runId) => {
            // Durable AVANT le moindre fournisseur, et avant l'accusé : c'est
            // ce qui rend une réponse perdue rattrapable.
            associated = await deps.store.associateRun(operationId, runId);
            await deps.startHooks?.onRunAllocated?.(runId);
            handshake.resolve();
          },
        },
      );
      void outcome;
      await deps.startHooks?.afterFinalization?.();
      return toPublicReceipt(await deps.store.settle(operationId, { status: 'SUCCEEDED' }));
    } catch (error) {
      if (!admitted || associated === undefined) handshake.reject(error);

      // Un run alloué que le reçu ne peut pas nommer.
      //
      // Écrire `FAILED` ici serait un mensonge : un run **existe**, et le
      // client l'apprendrait comme un échec sans jamais pouvoir le retrouver.
      // Écrire `SUCCEEDED` en serait un autre. Il ne reste que la vérité —
      // l'instance sait que l'exécution a cessé, et qu'elle ne peut pas la
      // représenter. Même mécanique qu'au Slice 5 : éphémère, non canonique,
      // sans influence sur la révision ni sur la vivacité, et remplacée après
      // redémarrage par la requalification d'instance.
      if (allocated !== undefined && associated === undefined) {
        deps.manager.markUncertain(operationId);
        return undefined;
      }

      const code = isCcrError(error) ? error.code : 'INTERNAL_ERROR';
      try {
        return toPublicReceipt(await deps.store.settle(operationId, { status: 'FAILED', errorCode: code }));
      } catch {
        deps.manager.markUncertain(operationId);
        return undefined;
      }
    }
  })();

  try {
    const settledEarly = await Promise.race([handshake.promise.then(() => undefined), task]);
    if (settledEarly !== undefined) return respondFor(settledEarly);

    // Les deux branches de la course rendent `undefined` : « admise, rien de
    // terminal » et « terminée sans verdict représentable » sont
    // indistinguables ici. C'est l'association qui tranche — et c'est aussi
    // elle qui donne son sens à l'accusé. Sans `created_run_id` durable, un
    // `202` promettrait un run que le client ne pourrait jamais retrouver.
    if (associated === undefined) {
      return respondFor({ ...toPublicReceipt(claim.receipt), status: 'UNKNOWN' });
    }
    const accepted = toPublicReceipt(associated);
    return { status: 202, body: accepted, receipt: accepted };
  } catch {
    const settled = await task;
    if (settled !== undefined) return respondFor(settled);
    return respondFor({ ...toPublicReceipt(claim.receipt), status: 'UNKNOWN' });
  }
}

// --------------------------------------------------------------------------
// Reprise — cinq intentions, cinq routes (V2-IMP-40A)
// --------------------------------------------------------------------------

/**
 * Table close des segments de capacité.
 *
 * La capacité est un segment de chemin, jamais un champ de corps : une route
 * inconnue est un `404`, pas une intention à interpréter.
 */
export const RECOVERY_ROUTES: Readonly<Record<string, RecoveryCapabilityId>> = {
  'finalize-journaled-response': 'RECOVERY_FINALIZE_JOURNALED_RESPONSE',
  'continue-initialization': 'RECOVERY_CONTINUE_INITIALIZATION',
  'materialize-ambiguity': 'RECOVERY_MATERIALIZE_AMBIGUITY',
  'acknowledge-ambiguity': 'RECOVERY_ACKNOWLEDGE_AMBIGUITY',
  'clear-stale-lock': 'RECOVERY_CLEAR_STALE_LOCK',
};

export const MAX_ACKNOWLEDGEMENT_BYTES = MAX_DECISION_CONTENT_BYTES;

interface ValidatedRecoveryPayload {
  readonly expectedRevision?: string;
  readonly acknowledgementText?: string;
  readonly observedLockToken?: string;
}

/**
 * Valide le corps selon la capacité — trois schémas, pas un de plus.
 *
 * Le transport est **plus strict** que V1 : une note d'acquittement sur une
 * autre route est un champ inattendu, là où la primitive l'ignorait en silence.
 * Une note qui n'aura aucun effet est une intention mal formée.
 */
function validateRecoveryPayload(
  capability: RecoveryCapabilityId,
  body: string,
): ValidatedRecoveryPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw invalid('Corps JSON illisible.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalid('Le corps doit être un objet JSON.');
  }
  const candidate = parsed as Record<string, unknown>;

  if (capability === 'RECOVERY_CLEAR_STALE_LOCK') {
    for (const key of Object.keys(candidate)) {
      if (key !== 'observed_lock_token') throw invalid(`Champ inattendu : ${key}.`);
    }
    const token = candidate['observed_lock_token'];
    // Un jeton hors forme est refusé avant que le système de fichiers soit
    // touché : sa borne est celle du champ, pas celle du corps.
    if (!isLockToken(token)) throw invalid("`observed_lock_token` absent ou mal formé.");
    return { observedLockToken: token };
  }

  const acknowledging = capability === 'RECOVERY_ACKNOWLEDGE_AMBIGUITY';
  const allowed = acknowledging ? ['expected_revision', 'acknowledgement_text'] : ['expected_revision'];
  for (const key of Object.keys(candidate)) {
    if (!allowed.includes(key)) throw invalid(`Champ inattendu : ${key}.`);
  }

  const revision = candidate['expected_revision'];
  if (typeof revision !== 'string' || !REVISION_PATTERN.test(revision)) {
    throw invalid('`expected_revision` absente ou mal formée.');
  }
  if (!acknowledging) return { expectedRevision: revision };

  const note = candidate['acknowledgement_text'];
  if (typeof note !== 'string' || note.trim().length === 0) {
    throw invalid("Acquitter une ambiguïté exige une note humaine non vide.");
  }
  if (Buffer.byteLength(note, 'utf8') > MAX_ACKNOWLEDGEMENT_BYTES) {
    throw new CcrError('PAYLOAD_TOO_LARGE', "Note d'acquittement trop volumineuse.");
  }
  return { expectedRevision: revision, acknowledgementText: note };
}

export interface RecoveryMutationDepsHttp extends MutationDeps {
  readonly manager: LongOperationManager;
  readonly recoveryHooks?: CanonicalRecoveryHooks & ClearStaleRunLockHooks;
}

/**
 * Exécute `POST /api/runs/:id/recovery/:capability`.
 *
 * Quatre capacités canoniques passent par le service applicatif — révision et
 * capacité recalculées sous **un seul** verrou. La cinquième, la levée, ne
 * prend aucun verrou et n'est pas une reprise : elle ne consomme aucun créneau
 * et n'enchaîne rien.
 *
 * Une seule capacité joint un fournisseur, et elle seule réserve un créneau :
 * `RECOVERY_CONTINUE_INITIALIZATION`. Son `202` part à l'admission, par la même
 * poignée de main que `START`, `STEP` et `SEND`.
 */
export async function executeRecoveryMutation(
  deps: RecoveryMutationDepsHttp,
  request: MutationRequest,
): Promise<MutationResponse> {
  const capability = RECOVERY_ROUTES[request.routeSegment];
  if (capability === undefined) throw new CcrError('RUN_NOT_FOUND', 'Capacité de reprise inconnue.');
  if (!isRunId(request.runId)) throw invalid('Identifiant de run non canonique.');
  // La reprise native a sa propre matrice `domaine × geste` (2E-R), sans
  // rapport avec la taxonomie V1. Tant qu'elle n'est pas portee, un run natif
  // est refuse **avant** le moteur historique — jamais laisse y tomber.
  if (request.generation === 'NATIVE_V21_EXECUTION') {
    throw unsupportedForGeneration(`recovery/${request.routeSegment}`, request.runId);
  }

  assertJsonContentType(request.contentType);
  const payload = validateRecoveryPayload(capability, request.body);
  const key = validateKey(request.idempotencyKey);

  // L'empreinte porte sur l'intention, jamais sur le chemin : une route est
  // une syntaxe, la capacité est ce que l'humain a voulu.
  const fingerprint = computeFingerprint({
    method: 'POST',
    action: capability,
    runId: request.runId,
    ...(payload.expectedRevision === undefined ? {} : { expectedRevision: payload.expectedRevision }),
    ...(payload.acknowledgementText === undefined
      ? {}
      : { contentDigest: digestOfContent(payload.acknowledgementText) }),
    ...(payload.observedLockToken === undefined
      ? {}
      : { contentDigest: digestOfContent(payload.observedLockToken) }),
  });

  const claim = await deps.store.claim({
    idempotencyKey: key,
    fingerprint,
    runId: request.runId,
    action: capability,
  });

  if (claim.kind === 'EXISTING') {
    // Retransmission : le verdict déjà rendu, sans réévaluer le monde.
    const known = deps.manager.isUncertain(claim.receipt.operation_id)
      ? { ...toPublicReceipt(claim.receipt), status: 'UNKNOWN' as const }
      : toPublicReceipt(claim.receipt);
    return respondFor(known);
  }

  const operationId = claim.receipt.operation_id;

  if (capability === 'RECOVERY_CLEAR_STALE_LOCK') {
    return settleRecovery(deps, operationId, async () => {
      await clearStaleRunLock(
        { runsDir: deps.runService.runsDir, ...(deps.runService.hostRegistry === undefined ? {} : { hostRegistry: deps.runService.hostRegistry }) },
        { runId: request.runId, observedLockToken: payload.observedLockToken ?? '' },
        deps.recoveryHooks ?? {},
      );
      // Aucune révision : la levée ne participe pas à la ligne canonique.
      return undefined;
    });
  }

  const canonical = capability as CanonicalRecoveryCapabilityId;
  const input = {
    runId: request.runId,
    expectedRevision: payload.expectedRevision ?? '',
    capability: canonical,
    ...(payload.acknowledgementText === undefined ? {} : { acknowledgementText: payload.acknowledgementText }),
  };

  if (canonical !== 'RECOVERY_CONTINUE_INITIALIZATION') {
    return settleRecovery(deps, operationId, async () => {
      const outcome = await applyCanonicalRecovery(deps.runService, input, deps.recoveryHooks ?? {});
      return outcome.revisionAfter;
    });
  }

  // Seule capacité longue : l'accusé part à l'admission, jamais après l'agent.
  let admitted = false;
  const handshake = deferred<void>();
  let slot: { release(): void } | undefined;

  const task = (async (): Promise<PublicOperationReceipt | undefined> => {
    try {
      const outcome = await applyCanonicalRecovery(deps.runService, input, {
        ...deps.recoveryHooks,
        onReadyForEffect: async (id) => {
          slot = deps.manager.admit(operationId);
          admitted = true;
          await deps.recoveryHooks?.onReadyForEffect?.(id);
          handshake.resolve();
        },
      },
      // Une opération HTTP, un identifiant : il voyage jusqu'à l'engagement.
      { operationId });
      return toPublicReceipt(
        await deps.store.settle(operationId, { status: 'SUCCEEDED', revisionAfter: outcome.revisionAfter }),
      );
    } catch (error) {
      if (!admitted) handshake.reject(error);
      const code = isCcrError(error) ? error.code : 'INTERNAL_ERROR';
      try {
        return toPublicReceipt(await deps.store.settle(operationId, { status: 'FAILED', errorCode: code }));
      } catch {
        deps.manager.markUncertain(operationId);
        return undefined;
      }
    } finally {
      slot?.release();
    }
  })();

  try {
    const settledEarly = await Promise.race([handshake.promise.then(() => undefined), task]);
    if (settledEarly !== undefined) return respondFor(settledEarly);
    const accepted = toPublicReceipt(claim.receipt);
    return { status: 202, body: accepted, receipt: accepted };
  } catch {
    const settled = await task;
    if (settled !== undefined) return respondFor(settled);
    return respondFor({ ...toPublicReceipt(claim.receipt), status: 'UNKNOWN' });
  }
}

/** Exécute un effet court et terminalise son reçu — succès comme échec. */
async function settleRecovery(
  deps: RecoveryMutationDepsHttp,
  operationId: string,
  effect: () => Promise<string | undefined>,
): Promise<MutationResponse> {
  try {
    const revisionAfter = await effect();
    return respondFor(
      toPublicReceipt(
        await deps.store.settle(operationId, {
          status: 'SUCCEEDED',
          ...(revisionAfter === undefined ? {} : { revisionAfter }),
        }),
      ),
    );
  } catch (error) {
    const code = isCcrError(error) ? error.code : 'INTERNAL_ERROR';
    if (!DETERMINISTIC_FAILURES.has(code)) {
      // Échec dont on ne peut pas affirmer qu'il n'a rien fait : le reçu reste
      // `RUNNING` et sera lu `UNKNOWN` après redémarrage.
      throw error;
    }
    return respondFor(toPublicReceipt(await deps.store.settle(operationId, { status: 'FAILED', errorCode: code })));
  }
}


// --------------------------------------------------------------------------
// Reprise native — `domaine × geste`, et rien d'autre (V2.1-IMP-17D)
// --------------------------------------------------------------------------

interface ValidatedNativeRecoveryPayload {
  readonly expectedRevision: string;
  readonly domain: NativeRecoveryDomain;
  readonly action: NativeRecoveryActionId;
  /** Transmise **bit pour bit**. Le serveur n'en rédige ni n'en normalise aucune. */
  readonly note?: string;
}

/**
 * Valide l'intention de reprise — syntaxe et matrice, jamais disponibilité.
 *
 * `domain=step, action=finalize` est statiquement valide même lorsque la reprise
 * de transfert vaut `NONE` : c'est la primitive, sous le verrou, qui refusera.
 * Décider ici reviendrait à autoriser depuis un instantané de lecture.
 */
function validateNativeRecoveryPayload(body: string): ValidatedNativeRecoveryPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw invalid('Corps JSON illisible.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalid('Le corps doit être un objet JSON.');
  }
  const candidate = parsed as Record<string, unknown>;
  for (const key of Object.keys(candidate)) {
    if (!['expected_revision', 'domain', 'action', 'note'].includes(key)) {
      throw invalid(`Champ inattendu : ${key}.`);
    }
  }

  const revision = candidate['expected_revision'];
  if (typeof revision !== 'string' || !REVISION_PATTERN.test(revision)) {
    throw invalid('`expected_revision` absente ou mal formée.');
  }

  const domain = candidate['domain'];
  if (typeof domain !== 'string' || !isNativeRecoveryDomain(domain)) {
    throw invalid(`\`domain\` doit valoir : ${NATIVE_RECOVERY_DOMAINS.join(', ')}.`);
  }
  const slug = candidate['action'];
  if (typeof slug !== 'string') {
    throw invalid(`\`action\` doit valoir : ${Object.keys(NATIVE_RECOVERY_ACTION_SLUGS).join(', ')}.`);
  }
  const action = nativeRecoveryActionOf(slug);
  if (action === undefined) {
    throw invalid(`Geste de reprise inconnu : ${slug}.`);
  }
  // Aucune approximation vers un geste voisin : le couple n'existe pas.
  if (!isSupportedPair(domain, action)) throw unsupportedPairError(domain, action);

  const note = candidate['note'];
  if (requiresNote(action)) {
    // Le `trim` **teste**, il ne transforme pas : la chaîne transmise reste
    // celle reçue, espaces compris.
    if (typeof note !== 'string' || note.trim().length === 0) {
      throw invalid('`note` est obligatoire : un acquittement est une affirmation humaine.');
    }
    return { expectedRevision: revision, domain, action, note };
  }
  if (note !== undefined) {
    // Jamais ignorée en silence : une note sans effet est une intention mal
    // formée, et le transport est plus strict que la primitive.
    throw invalid(
      `\`note\` ne s'applique pas à « ${slug} » : seuls les acquittements en exigent une. ` +
        `Gestes de ce domaine : ${slugsOf(domain).join(', ')}.`,
    );
  }
  return { expectedRevision: revision, domain, action };
}

export interface NativeRecoveryMutationDepsHttp extends MutationDeps {
  readonly manager: LongOperationManager;
}

/**
 * Exécute `POST /api/runs/:id/recovery` sur un run **natif**.
 *
 * Même composition que les autres mutations : claim durable, précondition de vue
 * sous le verrou du moteur, reçu terminal. Le geste est celui que l'humain a
 * nommé — aucune inspection ne choisit pour lui.
 */
export async function executeNativeRecoveryMutation(
  deps: NativeRecoveryMutationDepsHttp,
  request: MutationRequest,
): Promise<MutationResponse> {
  if (!isRunId(request.runId)) throw invalid('Identifiant de run non canonique.');
  if (request.generation !== 'NATIVE_V21_EXECUTION') {
    // Les deux contrats de reprise restent séparés : `domaine × geste` n'a
    // aucune traduction vers les capacités V1, et en inventer une reviendrait
    // à décider ce que l'humain a voulu.
    throw unsupportedForGeneration('recovery (domain/action)', request.runId);
  }

  assertJsonContentType(request.contentType);
  const payload = validateNativeRecoveryPayload(request.body);
  const key = validateKey(request.idempotencyKey);

  // L'empreinte distingue le domaine, le geste **et** la note exacte : deux
  // notes différentes ne sont pas la même intention.
  const fingerprint = computeFingerprint({
    method: 'POST',
    action: `NATIVE_RECOVERY:${payload.domain}:${payload.action}`,
    runId: request.runId,
    expectedRevision: payload.expectedRevision,
    ...(payload.note === undefined ? {} : { contentDigest: digestOfContent(payload.note) }),
  });

  const claim = await deps.store.claim({
    idempotencyKey: key,
    fingerprint,
    runId: request.runId,
    action: `NATIVE_RECOVERY:${payload.domain}:${payload.action}`,
  });

  if (claim.kind === 'EXISTING') {
    const known = deps.manager.isUncertain(claim.receipt.operation_id)
      ? { ...toPublicReceipt(claim.receipt), status: 'UNKNOWN' as const }
      : toPublicReceipt(claim.receipt);
    return respondFor(known);
  }

  const operationId = claim.receipt.operation_id;
  let admitted = false;
  const handshake = deferred<void>();

  const task = (async (): Promise<PublicOperationReceipt | undefined> => {
    try {
      const outcome = await applyNativeRecoveryMutation(
        { runService: deps.runService, manager: deps.manager, operationId },
        {
          runId: request.runId,
          expectedRevision: payload.expectedRevision,
          domain: payload.domain,
          action: payload.action,
          ...(payload.note === undefined ? {} : { note: payload.note }),
        },
        {
          onAdmitted: () => {
            admitted = true;
            handshake.resolve();
          },
        },
      );
      return toPublicReceipt(
        await deps.store.settle(operationId, {
          status: 'SUCCEEDED',
          revisionAfter: outcome.revisionAfter,
        }),
      );
    } catch (error) {
      if (!admitted) handshake.reject(error);
      const code = isCcrError(error) ? error.code : 'INTERNAL_ERROR';
      const revisionAfter = (error as { revisionAfter?: string }).revisionAfter;
      try {
        return toPublicReceipt(
          await deps.store.settle(operationId, {
            status: 'FAILED',
            errorCode: code,
            ...(revisionAfter === undefined ? {} : { revisionAfter }),
          }),
        );
      } catch {
        deps.manager.markUncertain(operationId);
        return undefined;
      }
    }
  })();

  try {
    // Une reprise locale se termine sans jamais demander d'admission : la
    // course rend alors directement son verdict.
    const settledEarly = await Promise.race([handshake.promise.then(() => undefined), task]);
    if (settledEarly !== undefined) return respondFor(settledEarly);
    return { status: 202, body: toPublicReceipt(claim.receipt), receipt: toPublicReceipt(claim.receipt) };
  } catch {
    const settled = await task;
    if (settled !== undefined) return respondFor(settled);
    return respondFor({ ...toPublicReceipt(claim.receipt), status: 'UNKNOWN' });
  }
}

// --------------------------------------------------------------------------
// V3 — controverses : une surface, une union fermée (contrat V3, `C-2` · `C-9`)
// --------------------------------------------------------------------------

/**
 * `POST /api/runs/:id/controversies`.
 *
 * **Une seule surface métier**, pas une route par type d'entrée : huit routes
 * multiplieraient huit fois la validation d'idempotence et de fraîcheur pour
 * une seule sémantique. Le discriminant `operation` sélectionne un schéma
 * fermé, et une valeur inconnue est refusée avant tout claim.
 *
 * ## Transport, et rien d'autre
 *
 * Cette couche ne connaît aucune règle intellectuelle du domaine. Elle ne
 * résout aucun ancrage, ne vérifie aucune paternité, n'inspecte aucune cible de
 * relation, ne détecte aucun doublon, n'alloue aucun identifiant et ne construit
 * jamais d'entrée. Elle valide une **forme**, garantit l'unicité de l'effet,
 * puis délègue à `controversy-service.ts`, qui tient le verrou.
 *
 * ```text
 * forme du corps      transport
 * plafonds            transport, puis S4 en dernière ligne
 * idempotence         transport
 * fraîcheur           S4, SOUS le verrou — jamais prévalidée ici
 * admission native    S4, via withNativeMutation
 * métier              S4
 * ```
 *
 * ## Fraîcheur : `expected_controversy_revision`, et elle seule
 *
 * Le jeton exigé est celui du **domaine V3** (`C-2`). Aucune révision de run
 * n'est demandée : un tour d'expert ne périme pas une controverse, et exiger un
 * second jeton créerait deux contrôles de concurrence optimiste là où le contrat
 * n'en définit qu'un.
 *
 * Sa **forme** n'est pas revalidée ici. Le transport vérifie qu'une chaîne non
 * vide est présente ; c'est S4 qui la compare, sous le verrou, à la révision
 * courante. Réécrire le format du jeton dans le transport en ferait une seconde
 * source de vérité, qui divergerait le jour où S2 changerait d'espace de noms.
 * Un jeton mal formé n'est donc pas une vue courante : il produit un
 * `STALE_REVISION` — public, déterministe, sans effet, et jamais un `500`.
 */
export const CONTROVERSY_MUTATION_ROUTE_SEGMENT = 'controversies';

/** Union fermée des opérations métier, telle que le plan gelé les nomme. */
export const CONTROVERSY_OPERATIONS = [
  'RECORD_CONTROVERSY',
  'RECORD_TRANSCRIPTION',
  'RECORD_ASSERTION',
  'RECORD_RELATION',
  'RECORD_NATURE',
  'RECORD_HUMAN_AUTHORITY',
  'CONFIRM_RELATION',
  'CONTEST_RELATION',
] as const;
export type ControversyOperation = (typeof CONTROVERSY_OPERATIONS)[number];

/** Champs admis, **par opération**. Tout autre champ est un corps mal formé. */
const CONTROVERSY_FIELDS: Readonly<Record<ControversyOperation, readonly string[]>> = {
  RECORD_CONTROVERSY: ['provenance_event_ids', 'statement', 'textual_anchor'],
  RECORD_TRANSCRIPTION: ['controversy_id', 'about_actor', 'anchor', 'statement', 'note'],
  RECORD_ASSERTION: ['controversy_id', 'provenance_event_ids', 'statement', 'textual_anchor', 'note'],
  RECORD_RELATION: ['controversy_id', 'provenance_event_ids', 'act', 'from_entry_id', 'to_entry_id', 'note'],
  RECORD_NATURE: ['controversy_id', 'provenance_event_ids', 'nature'],
  RECORD_HUMAN_AUTHORITY: ['controversy_id', 'provenance_event_ids', 'scope', 'target_entry_id', 'content'],
  CONFIRM_RELATION: ['controversy_id', 'provenance_event_ids', 'target_entry_id', 'content'],
  CONTEST_RELATION: ['controversy_id', 'provenance_event_ids', 'target_entry_id', 'content'],
};

/** Champs dont CCR est l'autorité — nommés pour que le refus soit explicite. */
const SERVER_OWNED_FIELDS: readonly string[] = [
  'entry_id',
  'schema_version',
  'recorded_at',
  'recorded_by',
  'round',
  'semantic_origin',
  'derivation',
  'invocation_id',
  'anchors',
  'relation',
  'authority',
  'provider_effect',
  'controversy_revision',
];

interface ValidatedControversyPayload {
  readonly operation: ControversyOperation;
  readonly expectedControversyRevision: string;
  /** Champs métier validés en **forme**, transmis tels quels au service. */
  readonly business: Readonly<Record<string, unknown>>;
}

function controversyField(candidate: Record<string, unknown>, key: string): unknown {
  return candidate[key];
}

/** Chaîne non vide et bornée. La borne est celle de S4, importée, jamais recopiée. */
function requiredText(candidate: Record<string, unknown>, key: string): string {
  const value = controversyField(candidate, key);
  if (typeof value !== 'string' || value.length === 0) {
    throw invalid(`\`${key}\` doit être une chaîne non vide.`);
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_CONTROVERSY_TEXT_BYTES) {
    // Refus, jamais troncature : un texte tronqué serait cité comme complet.
    throw new CcrError('PAYLOAD_TOO_LARGE', `\`${key}\` dépasse la borne d'écriture V3.`);
  }
  return value;
}

function optionalText(candidate: Record<string, unknown>, key: string): string | undefined {
  return controversyField(candidate, key) === undefined ? undefined : requiredText(candidate, key);
}

function requiredIdList(candidate: Record<string, unknown>, key: string): readonly string[] {
  const value = controversyField(candidate, key);
  if (!Array.isArray(value)) throw invalid(`\`${key}\` doit être une liste d'identifiants.`);
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.length === 0) {
      throw invalid(`\`${key}[${String(index)}]\` doit être une chaîne non vide.`);
    }
    return item;
  });
}

/**
 * Forme d'un ancrage textuel — trois champs, et rien d'autre.
 *
 * Aucune résolution n'a lieu ici : la citation n'est pas cherchée, l'occurrence
 * n'est pas comptée, l'événement n'est pas lu. Ce travail exige les faits
 * canoniques sous le verrou, et il appartient à S4.
 */
function textualAnchorOf(value: unknown, key: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(`\`${key}\` doit être un objet.`);
  }
  const anchor = value as Record<string, unknown>;
  for (const field of Object.keys(anchor)) {
    if (!['event_id', 'quoted_text', 'occurrence'].includes(field)) {
      throw invalid(`Champ inattendu dans \`${key}\` : ${field}.`);
    }
  }
  const eventId = requiredText(anchor, 'event_id');
  const quoted = requiredText(anchor, 'quoted_text');
  const occurrence = anchor['occurrence'];
  if (typeof occurrence !== 'number' || !Number.isInteger(occurrence)) {
    throw invalid(`\`${key}.occurrence\` doit être un entier.`);
  }
  return { event_id: eventId, quoted_text: quoted, occurrence };
}

/**
 * Valide la forme d'une intention V3.
 *
 * La normalisation se fait par **extraction de champs validés**, comme pour les
 * autres surfaces : l'ordre des propriétés du client n'influence donc jamais
 * l'empreinte, par construction plutôt que par tri.
 */
function validateControversyPayload(body: string): ValidatedControversyPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw invalid('Corps JSON illisible.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalid('Le corps doit être un objet JSON.');
  }
  const candidate = parsed as Record<string, unknown>;

  const operation = candidate['operation'];
  if (typeof operation !== 'string' || !(CONTROVERSY_OPERATIONS as readonly string[]).includes(operation)) {
    // Aucune forme générique : ni `append_entry`, ni `raw_kind`, ni charge
    // arbitraire. Un discriminant inconnu est refusé AVANT tout claim.
    throw invalid(`\`operation\` doit valoir : ${CONTROVERSY_OPERATIONS.join(', ')}.`);
  }
  const op = operation as ControversyOperation;

  const allowed = ['operation', 'expected_controversy_revision', ...(CONTROVERSY_FIELDS[op] ?? [])];
  for (const key of Object.keys(candidate)) {
    if (allowed.includes(key)) continue;
    if (SERVER_OWNED_FIELDS.includes(key)) {
      // Nommé, plutôt qu'ignoré en silence : un appelant qui croit poser une
      // origine sémantique doit apprendre qu'il ne le peut pas.
      throw invalid(`\`${key}\` est un champ dont CCR est l'autorité : il ne se fournit pas.`);
    }
    throw invalid(`Champ inattendu : ${key}.`);
  }

  const revision = candidate['expected_controversy_revision'];
  if (typeof revision !== 'string' || revision.length === 0) {
    throw invalid('`expected_controversy_revision` absente ou mal formée.');
  }

  const business: Record<string, unknown> = {};
  const put = (key: string, value: unknown): void => {
    if (value !== undefined) business[key] = value;
  };

  if (op !== 'RECORD_CONTROVERSY') put('controversy_id', requiredText(candidate, 'controversy_id'));
  if (op !== 'RECORD_TRANSCRIPTION') {
    put('provenance_event_ids', requiredIdList(candidate, 'provenance_event_ids'));
  }

  switch (op) {
    case 'RECORD_CONTROVERSY':
    case 'RECORD_ASSERTION': {
      put('statement', requiredText(candidate, 'statement'));
      const anchor = candidate['textual_anchor'];
      if (anchor !== undefined) put('textual_anchor', textualAnchorOf(anchor, 'textual_anchor'));
      put('note', optionalText(candidate, 'note'));
      break;
    }
    case 'RECORD_TRANSCRIPTION': {
      const about = candidate['about_actor'];
      if (typeof about !== 'string' || !isExpertSlotId(about)) {
        throw invalid('`about_actor` doit nommer un slot d’expert.');
      }
      put('about_actor', about);
      put('anchor', textualAnchorOf(candidate['anchor'], 'anchor'));
      put('statement', requiredText(candidate, 'statement'));
      put('note', optionalText(candidate, 'note'));
      break;
    }
    case 'RECORD_RELATION': {
      const act = candidate['act'];
      // L'union est celle du domaine, importée — jamais redéclarée ici. S4
      // reste l'autorité : ce contrôle porte sur la forme du DTO.
      if (typeof act !== 'string' || !(RELATION_ACTS as readonly string[]).includes(act)) {
        throw invalid(`\`act\` doit valoir : ${RELATION_ACTS.join(', ')}.`);
      }
      put('act', act);
      put('from_entry_id', requiredText(candidate, 'from_entry_id'));
      put('to_entry_id', requiredText(candidate, 'to_entry_id'));
      put('note', optionalText(candidate, 'note'));
      break;
    }
    case 'RECORD_NATURE': {
      put('nature', requiredText(candidate, 'nature'));
      break;
    }
    case 'RECORD_HUMAN_AUTHORITY': {
      put('scope', requiredText(candidate, 'scope'));
      put('target_entry_id', optionalText(candidate, 'target_entry_id'));
      put('content', optionalText(candidate, 'content'));
      break;
    }
    case 'CONFIRM_RELATION':
    case 'CONTEST_RELATION': {
      put('target_entry_id', requiredText(candidate, 'target_entry_id'));
      put('content', optionalText(candidate, 'content'));
      break;
    }
  }

  return { operation: op, expectedControversyRevision: revision, business };
}

/**
 * Condensat du geste métier, hors discriminant et hors jeton de fraîcheur —
 * ces deux-là occupent leurs propres emplacements dans l'empreinte.
 *
 * Construit depuis les champs **validés**, dans un ordre de clés trié : deux
 * corps JSON équivalents aux propriétés ordonnées différemment produisent la
 * même empreinte, et deux textes distincts en produisent deux. Aucune
 * normalisation sémantique n'est appliquée — ce serait une inférence non
 * attribuée, et deux gestes voisins ne sont pas le même geste.
 */
function controversyBusinessDigest(business: Readonly<Record<string, unknown>>): string {
  const canonical = (value: unknown): string => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  };
  return digestOfContent(canonical(business));
}

/**
 * Dépendances de la surface V3 — **ni seams, ni manager**.
 *
 * Une opération V3 est courte et n'appelle aucun fournisseur : ne pas exiger de
 * gestionnaire d'opérations longues est la preuve, au niveau du type, qu'aucun
 * créneau ne peut être réservé depuis ici.
 */
export interface ControversyMutationDepsHttp {
  readonly runService: RunServiceDeps;
  readonly store: OperationStore;
}

/**
 * Exécute une mutation V3 — claim durable, service métier, reçu terminal.
 *
 * Même composition que les mutations courtes, dans le même ordre gelé : le
 * claim précède les préconditions, de sorte qu'une retransmission de la *même*
 * tentative ne devienne pas un succès parce que le monde a changé entre-temps.
 *
 * Aucune garde de génération n'est posée ici. `withNativeMutation`, à
 * l'intérieur du service, refuse un run historique avant tout fait durable, et
 * ce refus est déterministe : il produit un reçu terminal comme les autres. Le
 * dupliquer au transport ajouterait une seconde autorité d'admission.
 */
export async function executeControversyMutation(
  deps: ControversyMutationDepsHttp,
  request: MutationRequest,
): Promise<MutationResponse> {
  if (!isRunId(request.runId)) throw invalid('Identifiant de run non canonique.');

  assertJsonContentType(request.contentType);
  const payload = validateControversyPayload(request.body);
  const key = validateKey(request.idempotencyKey);

  const action = `CONTROVERSY:${payload.operation}`;
  const fingerprint = computeFingerprint({
    method: 'POST',
    action,
    runId: request.runId,
    // Le jeton V3 occupe l'emplacement de fraîcheur : deux révisions distinctes
    // ne sont pas la même tentative, même clé et même corps.
    expectedRevision: payload.expectedControversyRevision,
    contentDigest: controversyBusinessDigest(payload.business),
  });

  const claim = await deps.store.claim({ idempotencyKey: key, fingerprint, runId: request.runId, action });

  if (claim.kind === 'EXISTING') {
    // Retransmission : le verdict déjà rendu, quel qu'il soit — `SUCCEEDED`,
    // `FAILED` ou `UNKNOWN`. Aucun service rappelé, aucune réévaluation, aucun
    // second append. Le reçu est l'autorité de l'opération passée ; le journal
    // n'est pas relu pour reconstituer un résultat.
    return respondFor(toPublicReceipt(claim.receipt));
  }

  const operationId = claim.receipt.operation_id;

  try {
    const outcome = await dispatchControversyOperation(deps.runService, request.runId, payload);
    const settled = await deps.store.settle(operationId, {
      status: 'SUCCEEDED',
      // La révision résultante du **domaine V3**, telle que le service l'a
      // calculée sous son verrou. Son préfixe la distingue visiblement d'une
      // révision de run : les deux ne peuvent pas être confondues.
      revisionAfter: outcome.controversy_revision,
    });
    return respondFor(toPublicReceipt(settled));
  } catch (error) {
    const code = isCcrError(error) ? error.code : 'INTERNAL_ERROR';
    if (!DETERMINISTIC_FAILURES.has(code)) throw error;
    const settled = await deps.store.settle(operationId, { status: 'FAILED', errorCode: code });
    return respondFor(toPublicReceipt(settled));
  }
}

/**
 * Aiguillage vers l'opération métier nommée — une fonction par opération.
 *
 * L'exhaustivité est portée par le type : ajouter une valeur à l'union sans
 * l'aiguiller ici casse le `typecheck`, plutôt que de tomber dans une branche
 * générique qu'il faudrait inventer.
 */
function dispatchControversyOperation(
  deps: ControversyServiceDeps,
  runId: string,
  payload: ValidatedControversyPayload,
): Promise<ControversyMutationResult> {
  const common = { runId, expected_controversy_revision: payload.expectedControversyRevision };
  const input = { ...common, ...payload.business };

  switch (payload.operation) {
    case 'RECORD_CONTROVERSY':
      return recordControversy(deps, input as Parameters<typeof recordControversy>[1]);
    case 'RECORD_TRANSCRIPTION':
      return recordHumanTranscription(deps, input as Parameters<typeof recordHumanTranscription>[1]);
    case 'RECORD_ASSERTION':
      return recordAssertion(deps, input as Parameters<typeof recordAssertion>[1]);
    case 'RECORD_RELATION':
      return recordRelation(deps, input as Parameters<typeof recordRelation>[1]);
    case 'RECORD_NATURE':
      return recordNature(deps, input as Parameters<typeof recordNature>[1]);
    case 'RECORD_HUMAN_AUTHORITY':
      return recordHumanAuthority(deps, input as Parameters<typeof recordHumanAuthority>[1]);
    case 'CONFIRM_RELATION':
      return confirmInferredRelation(deps, input as Parameters<typeof confirmInferredRelation>[1]);
    case 'CONTEST_RELATION':
      return contestInferredRelation(deps, input as Parameters<typeof contestInferredRelation>[1]);
  }
}

// ==========================================================================
// Réconciliation V5 — surface de mutation (V5.1, addendum §17)
// ==========================================================================

/**
 * Segment de route V5 — `runs/:id/reconciliations`.
 *
 * Le §43 du contrat V5 disait « aucun chemin réservé, aucune route nommée ».
 * L'addendum V5.1 du 2026-08-21 le supersède, et lui seul : cette route existe
 * parce qu'une autorité humaine l'a contractée, pas parce qu'elle était commode.
 */
export const RECONCILIATION_MUTATION_ROUTE_SEGMENT = 'reconciliations';

/**
 * Union fermée des opérations V5 exposées.
 *
 * Trois opérations, et **deux services propriétaires** : la surface produit
 * demande quatre gestes humains, le contrat n'en connaît pas quatre.
 *
 * ```text
 * ACCEPT · REJECT   →  RESPOND         →  recordProposalResponse  (une réponse)
 * MODIFY · REPLACE  →  RECORD_ACT      →  recordReconciliation    (un acte)
 *                      responds_to.relation = MODIFIES | REPLACES
 * proposer          →  PROPOSE_BY_MODEL →  requestModelReconciliationProposal
 * ```
 *
 * `ACCEPT` n'est donc pas `ADOPTS` — ce ne sont même pas les mêmes opérations.
 * Inventer un quatrième mode de réponse pour obtenir quatre boutons aurait créé
 * une sémantique que le contrat ne porte pas.
 */
export const RECONCILIATION_OPERATIONS = [
  'RECORD_ACT',
  'RESPOND',
  'PROPOSE_BY_MODEL',
] as const;
export type ReconciliationOperation = (typeof RECONCILIATION_OPERATIONS)[number];

/**
 * Champs admis, **par opération**. Tout autre champ est un corps mal formé.
 *
 * Le transport vérifie la présence et la fermeture de l'ensemble ; il ne valide
 * **aucune valeur métier**. Ni `scope_kind`, ni `mode`, ni `relation`, ni le
 * genre de provenance : les transmettre telles quelles laisse le domaine seul
 * juge, et lui seul rend le motif exact d'un refus.
 */
const RECONCILIATION_FIELDS: Readonly<Record<ReconciliationOperation, readonly string[]>> = {
  RECORD_ACT: [
    'target_controversy_id',
    'scope_kind',
    'scope',
    'content',
    'provenance',
    'responds_to',
    'closure',
    'closure_withdrawal',
    'supersedes',
  ],
  RESPOND: [
    'target_controversy_id',
    'proposal_id',
    'mode',
    'responded_option_id',
    'provenance',
  ],
  PROPOSE_BY_MODEL: ['target_controversy_id', 'scope_kind', 'scope', 'expert_slot'],
};

/**
 * Champs dont CCR est l'autorité — nommés pour que le refus soit explicite.
 *
 * Un client qui les enverrait ne serait pas ignoré : il serait refusé. Se taire
 * laisserait croire qu'une origine sémantique ou un horodatage proposé a été
 * pris en compte.
 */
const RECONCILIATION_SERVER_OWNED_FIELDS: readonly string[] = [
  'entry_id',
  'schema_version',
  'recorded_at',
  'recorded_by',
  'round',
  'semantic_origin',
  'derivation',
  'invocation_id',
  'provider_effect',
  'reconciliation_revision',
  'observed_revision',
  'runId',
];

interface ValidatedReconciliationPayload {
  readonly operation: ReconciliationOperation;
  /**
   * Jeton de fraîcheur V5, exigé des deux opérations humaines.
   *
   * Absent de `PROPOSE_BY_MODEL` : le chemin assisté capture lui-même sa
   * référence `R0` sous verrou, avant le dispatch. Demander à l'appelant une
   * révision que le service n'utiliserait pas aurait été une garantie fictive.
   */
  readonly expectedRevision?: string;
  /** Champs métier transmis **tels quels** au service propriétaire. */
  readonly business: Readonly<Record<string, unknown>>;
}

function isReconciliationOperation(value: unknown): value is ReconciliationOperation {
  return typeof value === 'string'
    && (RECONCILIATION_OPERATIONS as readonly string[]).includes(value);
}

/**
 * Valide la **forme de transport** d'un corps V5, et rien de plus.
 *
 * ```text
 * objet · opération connue · ensemble de champs fermé · jeton de fraîcheur
 * ```
 *
 * Aucune valeur métier n'est inspectée. C'est délibéré : le domaine V5 refuse
 * déjà tout champ inconnu et toute valeur hors union, avec un motif nommé que le
 * transport serait incapable de reproduire fidèlement.
 */
function validateReconciliationPayload(body: string): ValidatedReconciliationPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw invalid('Corps JSON illisible.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalid('Le corps doit être un objet JSON.');
  }
  const candidate = parsed as Record<string, unknown>;

  const operation = candidate['operation'];
  if (!isReconciliationOperation(operation)) {
    throw invalid('`operation` doit nommer une opération de réconciliation connue.');
  }

  const allowed = RECONCILIATION_FIELDS[operation];
  const business: Record<string, unknown> = {};
  for (const field of Object.keys(candidate)) {
    if (field === 'operation' || field === 'expected_revision') continue;
    if (RECONCILIATION_SERVER_OWNED_FIELDS.includes(field)) {
      throw invalid(`\`${field}\` appartient à CCR : il n'est jamais reçu d'un client.`);
    }
    if (!allowed.includes(field)) {
      throw invalid(`Champ inattendu pour ${operation} : ${field}.`);
    }
    business[field] = candidate[field];
  }

  if (operation === 'PROPOSE_BY_MODEL') return { operation, business };

  const revision = candidate['expected_revision'];
  if (typeof revision !== 'string' || revision.length === 0) {
    throw invalid('`expected_revision` doit être une chaîne non vide.');
  }
  // Sa FORME n'est pas revalidée ici : c'est le service qui la compare, sous le
  // verrou, à la révision courante. Un second format dans le transport
  // divergerait le jour où l'espace de noms V5 changerait.
  return { operation, expectedRevision: revision, business };
}

/** Condensat stable du corps métier — l'ordre des clés ne change pas l'empreinte. */
function reconciliationBusinessDigest(business: Readonly<Record<string, unknown>>): string {
  const keys = Object.keys(business).sort();
  const canonical = keys.map((key) => [key, business[key]]);
  return digestOfContent(JSON.stringify(canonical));
}

/**
 * Dépendances de la surface V5.
 *
 * `manager` est **facultatif** : les deux opérations humaines sont courtes et
 * n'appellent aucun fournisseur. Il n'est exigé que pour la proposition
 * assistée, et son absence rend celle-ci indisponible plutôt que synchrone.
 */
export interface ReconciliationMutationDepsHttp {
  readonly runService: RunServiceDeps;
  readonly store: OperationStore;
  readonly manager?: LongOperationManager;
}

/**
 * Exécute une mutation V5.
 *
 * Deux régimes, une seule porte d'entrée :
 *
 * ```text
 * RECORD_ACT · RESPOND    court    claim → service → reçu terminal
 * PROPOSE_BY_MODEL        long     claim → créneau → 202 → tâche → reçu terminal
 * ```
 *
 * Aucune garde de génération n'est posée ici : `withNativeMutation`, dans le
 * service, refuse un run historique avant tout fait durable, et ce refus est
 * déterministe. Le dupliquer au transport ajouterait une seconde autorité
 * d'admission.
 */
export async function executeReconciliationMutation(
  deps: ReconciliationMutationDepsHttp,
  request: MutationRequest,
): Promise<MutationResponse> {
  if (!isRunId(request.runId)) throw invalid('Identifiant de run non canonique.');

  assertJsonContentType(request.contentType);
  const payload = validateReconciliationPayload(request.body);
  const key = validateKey(request.idempotencyKey);

  const action = `RECONCILIATION:${payload.operation}`;
  const fingerprint = computeFingerprint({
    method: 'POST',
    action,
    runId: request.runId,
    ...(payload.expectedRevision === undefined
      ? {}
      : { expectedRevision: payload.expectedRevision }),
    contentDigest: reconciliationBusinessDigest(payload.business),
  });

  const claim = await deps.store.claim({
    idempotencyKey: key,
    fingerprint,
    runId: request.runId,
    action,
  });

  if (claim.kind === 'EXISTING') {
    // Retransmission : le verdict déjà rendu, quel qu'il soit. Aucun service
    // rappelé, aucun second append, et surtout aucun second fournisseur.
    const known = deps.manager?.isUncertain(claim.receipt.operation_id) === true
      ? { ...toPublicReceipt(claim.receipt), status: 'UNKNOWN' as const }
      : toPublicReceipt(claim.receipt);
    return respondFor(known);
  }

  const operationId = claim.receipt.operation_id;

  if (payload.operation === 'PROPOSE_BY_MODEL') {
    return startReconciliationProposal(deps, request.runId, payload, claim.receipt, operationId);
  }

  try {
    const outcome = await dispatchReconciliationOperation(deps.runService, request.runId, payload);
    const settled = await deps.store.settle(operationId, {
      status: 'SUCCEEDED',
      // La révision du **domaine V5**, telle que le service l'a calculée sous
      // son verrou. Son préfixe la distingue d'une révision de run.
      revisionAfter: outcome.reconciliation_revision,
    });
    return respondFor(toPublicReceipt(settled));
  } catch (error) {
    const code = isCcrError(error) ? error.code : 'INTERNAL_ERROR';
    if (!DETERMINISTIC_FAILURES.has(code)) throw error;
    const settled = await deps.store.settle(operationId, { status: 'FAILED', errorCode: code });
    return respondFor(toPublicReceipt(settled));
  }
}

/**
 * Aiguillage vers l'opération humaine nommée.
 *
 * L'exhaustivité est portée par le type : `PROPOSE_BY_MODEL` est traité avant
 * d'arriver ici, et ajouter une opération à l'union sans l'aiguiller casse le
 * `typecheck` plutôt que de tomber dans une branche générique.
 */
function dispatchReconciliationOperation(
  deps: RunServiceDeps,
  runId: string,
  payload: ValidatedReconciliationPayload,
): Promise<{ readonly reconciliation_revision: string }> {
  const input = {
    runId,
    expected_revision: payload.expectedRevision,
    ...payload.business,
  };

  switch (payload.operation) {
    case 'RECORD_ACT':
      return recordReconciliation(deps, input as Parameters<typeof recordReconciliation>[1]);
    case 'RESPOND':
      return recordProposalResponse(deps, input as Parameters<typeof recordProposalResponse>[1]);
    case 'PROPOSE_BY_MODEL':
      // Inatteignable : la proposition assistée est aiguillée avant cet appel.
      throw invalid('La proposition assistée emprunte le régime long.');
  }
}

/**
 * Projette l'issue du chemin assisté dans le vocabulaire du reçu.
 *
 * Six issues, six branches, **aucune fusion** : le run réel `CCR-20260404-001`
 * a montré ce que coûte leur confusion — deux appels fournisseurs réels, aucun
 * enregistrement, et un écran qui annonçait « effectuée ». L'issue exacte
 * n'était alors récupérable nulle part.
 *
 * Ce qui est transporté existe déjà dans l'union propriétaire : rien n'est
 * calculé, rien n'est requalifié, rien n'est inventé. `PROVIDER_FAILED` reste
 * une issue **métier** et ne devient pas une panne de transport ; `VALID_ZERO`
 * ne devient pas un refus ; `RECORDED` reste le seul cas où quelque chose a
 * été écrit.
 *
 * L'exhaustivité est portée par le type : une septième issue ajoutée à l'union
 * casse le `typecheck` ici plutôt que de tomber silencieusement dans un cas
 * générique.
 */
export function describeProposalOutcome(
  outcome: PublicReconciliationProposalOutcome,
): OperationDomainOutcome {
  if (outcome.kind === 'NOT_AVAILABLE') {
    return { outcome: 'NOT_AVAILABLE', reason: outcome.availability };
  }

  const proposal = outcome.proposal;
  switch (proposal.kind) {
    case 'RECORDED':
      return { outcome: 'RECORDED', invocation_id: proposal.invocation_id };
    case 'VALID_ZERO':
      return { outcome: 'VALID_ZERO', invocation_id: proposal.invocation_id };
    case 'INVALID_OUTPUT':
      // `reason` nomme le motif du §36 ; `at` dit **où** la sortie a été
      // refusée. Les deux sont des diagnostics publics du parseur strict.
      return {
        outcome: 'INVALID_OUTPUT',
        reason: proposal.reason,
        detail: proposal.at,
        invocation_id: proposal.invocation_id,
      };
    case 'REVALIDATION_REFUSED':
      return {
        outcome: 'REVALIDATION_REFUSED',
        reason: proposal.check,
        detail: proposal.detail,
        invocation_id: proposal.invocation_id,
      };
    case 'PROVIDER_FAILED':
      return {
        outcome: 'PROVIDER_FAILED',
        reason: proposal.error_code,
        invocation_id: proposal.invocation_id,
      };
    default: {
      const unreachable: never = proposal;
      return unreachable;
    }
  }
}

/**
 * Démarre la proposition assistée — **opération longue**.
 *
 * Le `202` est rendu dès la réservation du créneau, sans attendre le
 * fournisseur. Ce qui précède — claim durable, admission — est donc entièrement
 * accompli quand le client reçoit son accusé, et rien de plus.
 *
 * ```text
 * POST  →  claim  →  créneau  →  202 + reçu  →  appel  →  reçu terminal
 * ```
 *
 * Aucune requête HTTP n'est maintenue ouverte pendant l'appel : le client suit
 * l'opération par son identifiant, comme pour un tour d'expert.
 */
async function startReconciliationProposal(
  deps: ReconciliationMutationDepsHttp,
  runId: string,
  payload: ValidatedReconciliationPayload,
  receipt: OperationReceipt,
  operationId: string,
): Promise<MutationResponse> {
  const manager = deps.manager;
  if (manager === undefined) {
    // Sans gestionnaire, aucun créneau ne peut être réservé. Le refus est
    // explicite : tenir la requête ouverte pendant l'appel serait pire.
    const settled = await deps.store.settle(operationId, {
      status: 'FAILED',
      errorCode: 'INTERNAL_ERROR',
    });
    return respondFor(toPublicReceipt(settled));
  }

  // `admit` est synchrone : la réservation est atomique sur la boucle
  // d'événements, et un refus `COCKPIT_BUSY` survient AVANT tout fournisseur.
  const slot = manager.admit(operationId);

  const request = { runId, ...payload.business };
  void (async (): Promise<void> => {
    try {
      const outcome = await requestModelReconciliationProposal(
        deps.runService,
        request as Parameters<typeof requestModelReconciliationProposal>[1],
      );
      // Une issue de domaine n'est pas un échec de transport : `INVALID_OUTPUT`,
      // `PROVIDER_FAILED` et `VALID_ZERO` sont des résultats, et le reçu les
      // porte **nommément**. Le statut dit que la tâche s'est déroulée jusqu'au
      // bout ; `domain_outcome` dit ce qu'elle a répondu. La révision, elle,
      // n'apparaît que lorsqu'une écriture a réellement eu lieu.
      await deps.store.settle(operationId, {
        status: 'SUCCEEDED',
        domain: describeProposalOutcome(outcome),
        ...(outcome.kind === 'DISPATCHED' && outcome.proposal.kind === 'RECORDED'
          ? { revisionAfter: outcome.proposal.reconciliation_revision }
          : {}),
      });
    } catch (error) {
      const code = isCcrError(error) ? error.code : 'INTERNAL_ERROR';
      try {
        await deps.store.settle(operationId, { status: 'FAILED', errorCode: code });
      } catch {
        // Le reçu terminal n'a pas pu être écrit : l'instance ne doit pas
        // continuer à annoncer `RUNNING` pour une tâche qu'elle sait finie.
        manager.markUncertain(operationId);
      }
    } finally {
      slot.release();
    }
  })();

  return {
    status: 202,
    body: toPublicReceipt(receipt),
    receipt: toPublicReceipt(receipt),
  };
}

// ==========================================================================
// Preuves V4 — surface de mutation (V5.1, addendum V3/V4 §7)
// ==========================================================================

/**
 * Segment de route V4 — `runs/:id/evidence`.
 *
 * Le contrat V4 fixait un premier palier « service + CLI » et un cockpit en
 * lecture seule (§30). L'addendum V3/V4 du 2026-08-21 supersède ces trois
 * lignes, et elles seules. Le §20.3 du même contrat avait déjà fixé la doctrine
 * d'idempotence de cette surface **avant** qu'elle n'existe : elle est reprise
 * sans altération.
 */
export const EVIDENCE_MUTATION_ROUTE_SEGMENT = 'evidence';

/**
 * Union fermée des opérations V4 exposées — **deux actes distincts**.
 *
 * ```text
 * REGISTER_MATERIAL   retenir un matériau        →  registerMaterial
 * ADDUCE_MATERIAL     le verser au débat         →  adduceMaterial
 * ```
 *
 * Les fusionner par commodité de transport aurait effacé la distinction que V4
 * existe pour tenir : `RETENTION ≠ ADDUCTION`. Un matériau retenu et jamais
 * versé reste un fait, et ne pas l'avoir versé ne dit rien de lui.
 */
export const EVIDENCE_OPERATIONS = ['REGISTER_MATERIAL', 'ADDUCE_MATERIAL'] as const;
export type EvidenceOperation = (typeof EVIDENCE_OPERATIONS)[number];

/**
 * Champs admis, **par opération**. Tout autre champ est un corps mal formé.
 *
 * Le transport vérifie la présence et la fermeture de l'ensemble ; il ne valide
 * **aucune valeur métier**. Ni la forme d'une représentation, ni l'orientation,
 * ni l'existence d'une cible : les transmettre telles quelles laisse le service
 * V4 seul juge, et lui seul rend le motif exact d'un refus.
 */
const EVIDENCE_FIELDS: Readonly<Record<EvidenceOperation, readonly string[]>> = {
  REGISTER_MATERIAL: ['representation', 'label'],
  ADDUCE_MATERIAL: ['material_id', 'target_entry_id', 'orientation', 'citation'],
};

/** Champs dont CCR est l'autorité — nommés pour que le refus soit explicite. */
const EVIDENCE_SERVER_OWNED_FIELDS: readonly string[] = [
  'entry_id',
  'schema_version',
  'recorded_at',
  'recorded_by',
  'semantic_origin',
  'derivation',
  'invocation_id',
  'observed_by_ccr',
  'submitted_by',
  'provider_effect',
  'evidence_revision',
  'runId',
];

interface ValidatedEvidencePayload {
  readonly operation: EvidenceOperation;
  readonly expectedRevision: string;
  readonly business: Readonly<Record<string, unknown>>;
}

function isEvidenceOperation(value: unknown): value is EvidenceOperation {
  return typeof value === 'string' && (EVIDENCE_OPERATIONS as readonly string[]).includes(value);
}

/**
 * Valide la **forme de transport** d'un corps V4, et rien de plus.
 *
 * ```text
 * objet · opération connue · ensemble de champs fermé · jeton de fraîcheur
 * ```
 */
function validateEvidencePayload(body: string): ValidatedEvidencePayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw invalid('Corps JSON illisible.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalid('Le corps doit être un objet JSON.');
  }
  const candidate = parsed as Record<string, unknown>;

  const operation = candidate['operation'];
  if (!isEvidenceOperation(operation)) {
    throw invalid(`\`operation\` doit valoir : ${EVIDENCE_OPERATIONS.join(', ')}.`);
  }

  const allowed = EVIDENCE_FIELDS[operation];
  const business: Record<string, unknown> = {};
  for (const field of Object.keys(candidate)) {
    if (field === 'operation' || field === 'expected_evidence_revision') continue;
    if (EVIDENCE_SERVER_OWNED_FIELDS.includes(field)) {
      throw invalid(`\`${field}\` appartient à CCR : il n'est jamais reçu d'un client.`);
    }
    if (!allowed.includes(field)) {
      throw invalid(`Champ inattendu pour ${operation} : ${field}.`);
    }
    business[field] = candidate[field];
  }

  const revision = candidate['expected_evidence_revision'];
  if (typeof revision !== 'string' || revision.length === 0) {
    throw invalid('`expected_evidence_revision` doit être une chaîne non vide.');
  }
  // Sa FORME n'est pas revalidée ici : c'est le service qui la compare, sous le
  // verrou, à la révision courante.
  return { operation, expectedRevision: revision, business };
}

/** Condensat stable du corps métier — l'ordre des clés ne change pas l'empreinte. */
function evidenceBusinessDigest(business: Readonly<Record<string, unknown>>): string {
  const keys = Object.keys(business).sort();
  return digestOfContent(JSON.stringify(keys.map((key) => [key, business[key]])));
}

/**
 * Dépendances de la surface V4 — **ni seams, ni manager**.
 *
 * Les deux opérations sont humaines, courtes, et n'appellent aucun fournisseur.
 * Ne pas exiger de gestionnaire d'opérations longues est la preuve, au niveau du
 * type, qu'aucun créneau ne peut être réservé depuis ici.
 */
export interface EvidenceMutationDepsHttp {
  readonly runService: RunServiceDeps;
  readonly store: OperationStore;
}

/**
 * Exécute une mutation V4 — claim durable, service métier, reçu terminal.
 *
 * Même composition que la surface V3, dans le même ordre gelé : le claim précède
 * les préconditions, de sorte qu'une retransmission de la *même* tentative ne
 * devienne pas un succès parce que le monde a changé entre-temps.
 */
export async function executeEvidenceMutation(
  deps: EvidenceMutationDepsHttp,
  request: MutationRequest,
): Promise<MutationResponse> {
  if (!isRunId(request.runId)) throw invalid('Identifiant de run non canonique.');

  assertJsonContentType(request.contentType);
  const payload = validateEvidencePayload(request.body);
  const key = validateKey(request.idempotencyKey);

  const action = `EVIDENCE:${payload.operation}`;
  const fingerprint = computeFingerprint({
    method: 'POST',
    action,
    runId: request.runId,
    expectedRevision: payload.expectedRevision,
    contentDigest: evidenceBusinessDigest(payload.business),
  });

  const claim = await deps.store.claim({
    idempotencyKey: key,
    fingerprint,
    runId: request.runId,
    action,
  });

  if (claim.kind === 'EXISTING') {
    // Rejeu de transport : le résultat DÉJÀ ENREGISTRÉ est rendu — le §20.3 du
    // contrat V4 l'exige en ces termes. Aucun service rappelé, aucun refus.
    return respondFor(toPublicReceipt(claim.receipt));
  }

  const operationId = claim.receipt.operation_id;

  try {
    const outcome = await dispatchEvidenceOperation(deps.runService, request.runId, payload);
    const settled = await deps.store.settle(operationId, {
      status: 'SUCCEEDED',
      // La révision du **domaine V4**, calculée par le service sous son verrou.
      revisionAfter: outcome.evidence_revision,
    });
    return respondFor(toPublicReceipt(settled));
  } catch (error) {
    const code = isCcrError(error) ? error.code : 'INTERNAL_ERROR';
    if (!DETERMINISTIC_FAILURES.has(code)) throw error;
    const settled = await deps.store.settle(operationId, { status: 'FAILED', errorCode: code });
    return respondFor(toPublicReceipt(settled));
  }
}

/**
 * Aiguillage vers l'opération V4 nommée — une fonction par opération.
 *
 * L'exhaustivité est portée par le type : ajouter une valeur à l'union sans
 * l'aiguiller ici casse le `typecheck`, plutôt que de tomber dans une branche
 * générique qu'il faudrait inventer.
 */
function dispatchEvidenceOperation(
  deps: RunServiceDeps,
  runId: string,
  payload: ValidatedEvidencePayload,
): Promise<{ readonly evidence_revision: string }> {
  const input = {
    runId,
    expected_evidence_revision: payload.expectedRevision,
    ...payload.business,
  };

  switch (payload.operation) {
    case 'REGISTER_MATERIAL':
      return registerMaterial(deps, input as Parameters<typeof registerMaterial>[1]);
    case 'ADDUCE_MATERIAL':
      return adduceMaterial(deps, input as Parameters<typeof adduceMaterial>[1]);
  }
}
