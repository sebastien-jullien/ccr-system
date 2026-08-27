/**
 * Phrases des avertissements de preflight.
 *
 * Le service produit des codes fermés ; ce module leur donne des mots. Aucune
 * décision, aucune sortie fournisseur.
 */

import type { StartPreflightWarning } from '../runtime/preflight-service.ts';

const MESSAGES: Record<StartPreflightWarning, string> = {
  CLAUDE_AUTH_UNKNOWN:
    "Le statut d'authentification de Claude Code n'a pas pu être déterminé. " +
    "CCR poursuit : l'appel réel reste l'autorité.",
  CODEX_AUTH_NOT_REPORTED:
    'Codex ne rapporte aucune connexion OpenAI active. ' +
    'Une autre configuration fournisseur peut néanmoins être utilisable ; CCR poursuit.',
  CODEX_AUTH_UNKNOWN:
    "Le statut d'authentification de Codex n'a pas pu être déterminé. CCR poursuit.",
  CODEX_LOGIN_REMEDIATION_FAILED:
    "La connexion Codex n'a pas abouti. CCR poursuit tout de même : cet échec ne prouve pas " +
    "qu'une configuration fournisseur alternative soit inutilisable.",
  LEGACY_ENV_OVERRIDE:
    'La variable CCR_CODEX_SKIP_GIT_REPO_CHECK est définie et prime sur la configuration.',
  LEGACY_ENV_NON_CANONICAL:
    'CCR_CODEX_SKIP_GIT_REPO_CHECK porte une valeur non canonique : seule la valeur exacte "1" ' +
    'active le contournement ; toute autre valeur vaut false.',
};

export function formatPreflightWarning(warning: StartPreflightWarning): string {
  return `Attention [${warning}] ${MESSAGES[warning]}`;
}
