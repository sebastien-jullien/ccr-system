/**
 * Écriture des observations d'usage autour d'un tour (`V2.2-IMP-03`).
 *
 * Petit helper, et volontairement petit. STEP et SEND écrivent exactement les
 * mêmes deux observations autour d'un retour d'adapter ; les dupliquer aurait
 * créé deux sémantiques portant le même nom — précisément ce que la doctrine
 * interdit depuis le journal natif.
 *
 * Ce n'est **pas** un moteur d'invocation générique : rien ici n'anticipe
 * START, la reprise ni le legacy. Ce module ne connaît ni run, ni verrou, ni
 * état, ni fournisseur — seulement un journal d'usage déjà ouvert et un tour
 * déjà obtenu.
 *
 * ## Non bloquant, jamais silencieux
 *
 * Une réponse de modèle appartient à la controverse. Si la gouvernance ne peut
 * pas être écrite, elle ne doit ni faire échouer l'opération, ni disparaître :
 * elle devient un avertissement structuré, sans prompt, sans réponse, sans
 * sortie brute et sans secret.
 */

import { CcrError } from '../core/errors.ts';
import { ccrElapsedMs } from '../core/usage.ts';
import type { UsageProvenance } from '../core/usage.ts';
import type { AgentTurnResult } from '../adapters/agent-adapter.ts';
import type { UsageLedgerStore } from '../store/usage-ledger.ts';

/**
 * Échec de gouvernance **non bloquant**, rendu à l'appelant.
 *
 * Ni un événement métier, ni une erreur : un fait de diagnostic.
 */
export interface UsageGovernanceWarning {
  readonly invocation_id: string;
  readonly provenance: UsageProvenance;
  readonly error_code: string;
}

export interface UsageRecorder {
  /** Observations qui n'ont pas pu être écrites. Vide en fonctionnement normal. */
  readonly warnings: readonly UsageGovernanceWarning[];
  record(provenance: UsageProvenance, payload: Record<string, unknown>): Promise<void>;
}

export function createUsageRecorder(
  usage: UsageLedgerStore,
  invocationId: string,
  now: () => Date,
): UsageRecorder {
  const warnings: UsageGovernanceWarning[] = [];
  return {
    warnings,
    async record(provenance, payload): Promise<void> {
      try {
        await usage.append({ invocation_id: invocationId, provenance, ...payload } as never, now());
      } catch (error) {
        warnings.push({
          invocation_id: invocationId,
          provenance,
          error_code: error instanceof CcrError ? error.code : 'UNEXPECTED',
        });
      }
    },
  };
}

/**
 * Consigne ce qu'un tour abouti a rendu observable.
 *
 * ```text
 * PROVIDER_REPORTED   uniquement si le fournisseur en a réellement publié une
 * CCR_MEASURED        toujours — c'est CCR qui mesure, et il a mesuré
 * ```
 *
 * Aucun jeton, aucun coût n'est inventé : une sortie dépourvue d'usage produit
 * une seule observation, et jamais des compteurs à zéro.
 */
export async function recordTurnUsage(recorder: UsageRecorder, turn: AgentTurnResult): Promise<void> {
  if (turn.usageObservation !== undefined) {
    await recorder.record('PROVIDER_REPORTED', {
      outcome: 'RESPONSE_RECEIVED',
      ...turn.usageObservation,
    });
  }
  const elapsed = ccrElapsedMs(turn);
  await recorder.record('CCR_MEASURED', {
    outcome: 'RESPONSE_RECEIVED',
    ...(elapsed === undefined ? {} : { ccr_elapsed_ms: elapsed }),
    exit_code: turn.exitCode,
  });
}
