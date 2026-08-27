/**
 * Jeton d'identité d'un verrou de run (V2-IMP-40A).
 *
 * Il dit une seule chose : « je demande la suppression **exactement** du verrou
 * que j'ai observé ». Rien d'autre.
 *
 * ```text
 * n'est pas un secret            aucune entropie serveur, aucun sel
 * n'est pas un porteur de droit  il n'autorise rien par lui-même
 * n'est pas réversible           ni PID ni nom d'hôte ne parviennent au client
 * n'est pas persisté             recalculé à chaque lecture
 * ```
 *
 * L'absence de sel est délibérée : un jeton doit rester valide après un
 * redémarrage du cockpit si le verrou, lui, n'a pas bougé.
 *
 * ## Sérialisation
 *
 * Une concaténation de chaînes de longueur variable serait ambiguë — deux
 * verrous distincts pourraient produire le même condensat. La forme est donc
 * fixée, et versionnée par la clé `v` qui entre elle-même dans le condensat.
 */

import { createHash } from 'node:crypto';

import type { RunLockInfo } from './run-lock.ts';

export const LOCK_TOKEN_VERSION = 1;
export const LOCK_TOKEN_PREFIX = 'lt1:';
export const LOCK_TOKEN_PATTERN = /^lt1:[A-Za-z0-9_-]{43}$/;
/** `lt1:` + 43 caractères base64url d'un SHA-256 sans remplissage. */
export const LOCK_TOKEN_LENGTH = 47;

/**
 * Condensat d'identité du verrou observé.
 *
 * L'ordre des clés est normatif : il fait partie de la sérialisation, pas de
 * la mise en forme. `JSON.stringify` sur un littéral d'objet préserve l'ordre
 * d'insertion, et le test de contrat le vérifie.
 */
export function lockTokenFor(runId: string, lock: RunLockInfo): string {
  const payload = JSON.stringify({
    v: LOCK_TOKEN_VERSION,
    run_id: runId,
    lock_id: lock.lock_id,
    pid: lock.pid,
    hostname: lock.hostname,
    started_at: lock.started_at,
    command: lock.command,
  });
  const digest = createHash('sha256').update(payload, 'utf8').digest('base64url');
  return `${LOCK_TOKEN_PREFIX}${digest}`;
}

export function isLockToken(value: unknown): value is string {
  return typeof value === 'string' && LOCK_TOKEN_PATTERN.test(value);
}
