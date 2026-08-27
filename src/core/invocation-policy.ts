/**
 * Politique de quota d'invocations d'un run (CCR V2.2, `V2.2-IMP-07`).
 *
 * Module **pur** : aucune entrée/sortie, aucune connaissance du disque, aucune
 * connaissance des fournisseurs. Il définit ce qu'une politique est, et ce
 * qu'un document doit prouver pour en être une.
 *
 * ## Ce que la politique porte, et rien d'autre
 *
 * ```text
 * max_invocations   entier >= 0
 * ```
 *
 * Elle ne porte ni jetons, ni coût, ni devise, ni limite journalière, ni limite
 * de compte, ni limite par fournisseur, ni réservation. Elle ne porte surtout
 * pas `consumed` ni `remaining` : le premier est **dérivé** du journal
 * d'invocations, qui en est l'autorité exacte, et le second s'en déduit. Les
 * persister créerait une seconde vérité, capable de contredire le journal.
 *
 * ## Absence et zéro sont opposés
 *
 * ```text
 * document absent        aucune politique de quota CCR — aucun refus
 * max_invocations = 0    politique valide — aucune invocation nouvelle permise
 * ```
 *
 * L'absence du document **est** le fait exact. Elle ne se représente donc ni
 * par `null`, ni par `-1`, ni par `Infinity`, ni par un `UNKNOWN` — qui
 * décriraient une ignorance, alors que CCR sait parfaitement qu'aucune règle
 * n'a été posée.
 *
 * ## Portée V0.1
 *
 * La politique est **per-run** et **stable une fois établie**. Ce module
 * n'expose donc aucune mutation : les règles de modification en cours de run —
 * autorisation, verrouillage, piste d'audit — appartiennent à une évolution
 * distincte, et ne sont pas anticipées ici.
 */

import { CcrError } from './errors.ts';

export const INVOCATION_POLICY_SCHEMA_VERSION = 1;

/** Versions de `invocation-policy.json` que cette version de CCR sait lire. */
export const SUPPORTED_INVOCATION_POLICY_SCHEMA_VERSIONS: readonly number[] = [1];

/** Document persistant, tel qu'il est écrit dans le répertoire du run. */
export interface InvocationPolicyDocument {
  readonly schema_version: number;
  readonly invocation_quota: {
    /** Nombre maximal de `DISPATCH_COMMITTED` que CCR s'autorise sur ce run. */
    readonly max_invocations: number;
  };
}

/**
 * Politique **résolue**, telle que le futur contrôle la lira.
 *
 * Union discriminée, et non un nombre nullable : « aucune règle » et « la règle
 * vaut zéro » sont deux faits opposés, et aucun appelant ne doit pouvoir les
 * confondre par distraction.
 */
export type ResolvedInvocationPolicy =
  | { readonly kind: 'NONE' }
  | { readonly kind: 'CONFIGURED'; readonly maxInvocations: number };

/** Aucune politique de quota CCR n'a été posée sur ce run. */
export const NO_INVOCATION_POLICY: ResolvedInvocationPolicy = { kind: 'NONE' };

const ROOT_KEYS: readonly string[] = ['schema_version', 'invocation_quota'];
const QUOTA_KEYS: readonly string[] = ['max_invocations'];

function invalid(message: string, details: Record<string, unknown> = {}): CcrError {
  return new CcrError('INVOCATION_POLICY_INVALID', message, { details });
}

/**
 * Refuse tout champ étranger.
 *
 * Même doctrine que le journal d'invocations : un champ inconnu est **refusé**,
 * jamais ignoré. Un document qui porterait une limite de jetons ou une devise
 * décrirait une politique que CCR n'applique pas, et l'ignorer en silence
 * laisserait croire qu'elle est respectée.
 */
function assertClosedKeys(record: Record<string, unknown>, allowed: readonly string[], at: string): void {
  for (const key of Object.keys(record)) {
    if (allowed.includes(key)) continue;
    throw invalid(`invocation-policy.json : champ « ${key} » inconnu dans ${at}.`, { at, field: key });
  }
}

function asRecord(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(`invocation-policy.json : ${at} doit être un objet JSON.`, { at });
  }
  return value as Record<string, unknown>;
}

/**
 * Valide un document de politique, sans aucune coercition.
 *
 * Une chaîne `"3"` n'est pas trois : la convertir accepterait un document que
 * son auteur n'a pas écrit.
 */
export function validateInvocationPolicyDocument(value: unknown): InvocationPolicyDocument {
  const record = asRecord(value, 'le document');
  assertClosedKeys(record, ROOT_KEYS, 'le document');

  const version = record['schema_version'];
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw invalid('invocation-policy.json : « schema_version » doit être un entier JSON.', {
      at: 'schema_version',
      found: version ?? null,
    });
  }
  if (!SUPPORTED_INVOCATION_POLICY_SCHEMA_VERSIONS.includes(version)) {
    throw invalid(
      `invocation-policy.json : schema_version ${String(version)} non supportée par cette version de CCR.`,
      { at: 'schema_version', supported: [...SUPPORTED_INVOCATION_POLICY_SCHEMA_VERSIONS], found: version },
    );
  }

  const quota = asRecord(record['invocation_quota'], 'invocation_quota');
  assertClosedKeys(quota, QUOTA_KEYS, 'invocation_quota');

  const max = quota['max_invocations'];
  if (typeof max !== 'number' || !Number.isSafeInteger(max)) {
    throw invalid(
      'invocation-policy.json : « max_invocations » doit être un entier JSON exactement représentable.',
      { at: 'invocation_quota.max_invocations', found: max ?? null },
    );
  }
  if (max < 0) {
    throw invalid(
      'invocation-policy.json : « max_invocations » ne peut pas être négatif. ' +
        'Zéro est une politique valide — elle interdit toute nouvelle invocation ; ' +
        "l'absence du document, elle, signifie qu'aucune politique n'a été posée.",
      { at: 'invocation_quota.max_invocations', found: max },
    );
  }

  return { schema_version: version, invocation_quota: { max_invocations: max } };
}

/** Construit un document valide à partir d'une limite. */
export function invocationPolicyDocument(maxInvocations: number): InvocationPolicyDocument {
  return validateInvocationPolicyDocument({
    schema_version: INVOCATION_POLICY_SCHEMA_VERSION,
    invocation_quota: { max_invocations: maxInvocations },
  });
}

/** Projette un document validé vers la politique que le futur contrôle lira. */
export function resolveInvocationPolicy(
  document: InvocationPolicyDocument | undefined,
): ResolvedInvocationPolicy {
  return document === undefined
    ? NO_INVOCATION_POLICY
    : { kind: 'CONFIGURED', maxInvocations: document.invocation_quota.max_invocations };
}
