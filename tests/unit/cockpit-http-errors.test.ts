/**
 * Mapper public d'erreurs (Slice 2, §31, §32).
 *
 * Deux propriétés, et la seconde est la plus importante :
 *
 *  1. les statuts distinguent réellement les situations — notamment
 *     `SNAPSHOT_UNSTABLE`, transitoire, d'une corruption stable ;
 *  2. **rien** d'interne ne franchit la frontière : ni `details`, ni `cause`,
 *     ni pile, ni argv, ni nom d'hôte, ni PID.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CcrError } from '../../src/core/errors.ts';
import type { CcrErrorCode } from '../../src/core/errors.ts';
import {
  publicErrorFor,
  isPublicCcrErrorCode,
  PUBLIC_CCR_ERROR_CODES,
  publishedCcrErrorCodes,
  transportError,
} from '../../src/cockpit/http-errors.ts';

test('(E1) statuts : chaque code publié a le statut attendu', () => {
  const expected: Partial<Record<CcrErrorCode, number>> = {
    INVALID_ARGUMENT: 400,
    RUN_NOT_FOUND: 404,
    STALE_REVISION: 409,
    RUN_ALREADY_LOCKED: 409,
    STALE_LOCK: 409,
    RUN_NOT_PAUSABLE: 422,
    RUN_NOT_RESUMABLE: 422,
    AUTOMATION_NOT_IN_CONTROL: 422,
    ILLEGAL_STATE_TRANSITION: 422,
    RECOVERY_REQUIRED: 422,
    MANIFEST_INVALID: 422,
    STATE_INVALID: 422,
    JOURNAL_INVALID: 422,
    SCHEMA_VERSION_UNSUPPORTED: 422,
    SNAPSHOT_UNSTABLE: 503,
    CONFIG_READ_FAILED: 422,
    CONFIG_INVALID: 422,
    CONFIG_SCHEMA_UNSUPPORTED: 422,
    INVALID_ORIGIN: 403,
    IDEMPOTENCY_KEY_REUSED: 409,
    OPERATION_NOT_FOUND: 404,
    OPERATION_STORE_CORRUPT: 422,
    PAYLOAD_TOO_LARGE: 413,
    UNSUPPORTED_MEDIA_TYPE: 415,
    NO_TRANSFERABLE_SOURCE: 422,
    SOURCE_ALREADY_TRANSFERRED: 422,
    PAYLOAD_TOO_LARGE_FOR_AUTOMATIC_TRANSFER: 422,
    SESSION_MISSING: 422,
    AGENT_TIMEOUT: 504,
    AGENT_EXIT_NONZERO: 422,
    AGENT_OUTPUT_UNPARSABLE: 422,
    AGENT_OUTPUT_INCOMPLETE: 422,
    AGENT_SESSION_ID_MISSING: 422,
    AGENT_RESULT_MISSING: 422,
    AGENT_SESSION_MISMATCH: 422,
    AGENT_REPORTED_ERROR: 422,
    AGENT_EXECUTABLE_UNRESOLVED: 422,
    // Slice 6 : la création rend ces deux situations atteignables par HTTP.
    // Elles décrivent l'environnement du poste, jamais la session du cockpit —
    // d'où 422 et non 401, qui déclencherait la reprise de session côté client.
    AGENT_CLI_NOT_FOUND: 422,
    AUTH_REQUIRED: 422,
    EXECUTABLE_NOT_FOUND: 422,
    PROCESS_LAUNCH_FAILED: 422,
    COCKPIT_BUSY: 503,
    COCKPIT_SHUTTING_DOWN: 503,
    // Slice 7 : trois refus de reprise, trois causes qu'un client doit pouvoir
    // distinguer. Les deux `409` demandent de recharger la vue ; le `422` dit
    // que la demande était bien formée mais que le monde s'y refuse.
    RECOVERY_CAPABILITY_STALE: 409,
    RECOVERY_LOCK_CHANGED: 409,
    RECOVERY_LOCK_NOT_CLEARABLE: 422,
    // Publication du verrou impossible : l'environnement du poste, pas la
    // requête — d'où 422, comme pour une CLI d'agent absente.
    LOCK_PUBLICATION_FAILED: 422,
    // V2.1-IMP-17B — refus métier des moteurs natifs. Tous stables, tous
    // constatés avant effet : `422`, jamais `500`.
    AMBIGUOUS_PROVIDER_ALIAS: 422,
    PROVIDER_ALIAS_NOT_BOUND: 422,
    SOURCE_NOT_REPLAYABLE: 422,
    SOURCE_STALE_AFTER_HANDOFF: 422,
    HANDOFF_NOT_ALLOWED: 422,
    RECOVERY_EVIDENCE_CONFLICT: 422,
    COMMAND_UNSUPPORTED_FOR_GENERATION: 422,
    // V2.2-IMP-02 — l'engagement d'invocation n'a pas pu être persisté. Panne
    // de l'environnement local, constatée avant tout appel : `422`, comme une
    // CLI d'agent absente, et surtout pas un `500` qui remplacerait le code.
    INVOCATION_LEDGER_WRITE_FAILED: 422,
  };

  for (const [code, status] of Object.entries(expected)) {
    const result = publicErrorFor(new CcrError(code as CcrErrorCode, 'message interne'));
    assert.equal(result.status, status, `${code} → ${String(status)}`);
    assert.equal(result.body.error.code, code);
  }

  // La table publiée et la table attendue coïncident exactement : un code
  // ajouté au mapper sans être décrit ici fait échouer ce test.
  assert.deepEqual([...publishedCcrErrorCodes()].sort(), Object.keys(expected).sort());

  // Fermeture dans les DEUX sens (V2.1-IMP-17B) : l'allowlist publique et la
  // table de mapping décrivent le même ensemble. Déclarer un code public sans
  // mapping le ferait tomber en `500` avec son code remplacé — le défaut exact
  // que ce slice ferme — et l'inverse publierait un code que rien ne déclare.
  assert.deepEqual([...PUBLIC_CCR_ERROR_CODES].sort(), [...publishedCcrErrorCodes()].sort());
  for (const code of PUBLIC_CCR_ERROR_CODES) {
    assert.equal(isPublicCcrErrorCode(code), true, code);
    assert.notEqual(publicErrorFor(new CcrError(code, 'x')).body.error.code, 'INTERNAL_ERROR', code);
  }
});

test('(E2) transitoire ≠ stable : 503 réessayable, 422 non', () => {
  const unstable = publicErrorFor(new CcrError('SNAPSHOT_UNSTABLE', 'x'));
  const corrupt = publicErrorFor(new CcrError('JOURNAL_INVALID', 'x'));

  assert.equal(unstable.status, 503);
  assert.equal(corrupt.status, 422);
  assert.notEqual(unstable.status, corrupt.status, 'confondre les deux mentirait au cockpit');
});

test('(E3) table fermée : un code non publié devient INTERNAL_ERROR', () => {
  // Un code interne jamais atteignable par HTTP reste invisible du navigateur.
  const result = publicErrorFor(new CcrError('RUN_ALREADY_EXISTS', 'run déjà existant'));
  assert.equal(result.status, 500);
  assert.equal(result.body.error.code, 'INTERNAL_ERROR');
  assert.equal(result.body.error.message.includes('existant'), false);
});

test('(E4) aucune divulgation : details, cause, pile, message interne', () => {
  const error = new CcrError('RUN_NOT_FOUND', 'chemin interne E:/secret/runs/CCR-1 introuvable', {
    details: {
      argv: ['codex', 'exec', '--dangerously-bypass'],
      hostname: 'POSTE-EXEMPLE',
      pid: 18244,
      stderr: 'token=sk-abcdef',
      path: 'E:/secret/runs',
    },
    cause: new Error('trace interne'),
  });

  const serialized = JSON.stringify(publicErrorFor(error));

  for (const secret of ['argv', 'dangerously', 'POSTE-EXEMPLE', '18244', 'sk-abcdef', 'E:/secret', 'trace interne', 'stack']) {
    assert.equal(serialized.includes(secret), false, `« ${secret} » ne doit pas franchir la frontière`);
  }
  assert.deepEqual(publicErrorFor(error).body, {
    error: { code: 'RUN_NOT_FOUND', message: "Ce run n'existe pas." },
  });
});

test('(E5) une valeur qui n’est pas une CcrError ne devine rien', () => {
  for (const thrown of [new Error('boum'), 'chaîne', null, undefined, { code: 'RUN_NOT_FOUND' }]) {
    const result = publicErrorFor(thrown);
    assert.equal(result.status, 500);
    assert.equal(result.body.error.code, 'INTERNAL_ERROR');
  }
});

test('(E6) codes de transport', () => {
  assert.equal(transportError('UNAUTHENTICATED').status, 401);
  assert.equal(transportError('INVALID_HOST').status, 403);
  assert.equal(transportError('METHOD_NOT_ALLOWED').status, 405);
  assert.equal(transportError('NOT_FOUND').status, 404);
  assert.equal(transportError('INTERNAL_ERROR').status, 500);
});
