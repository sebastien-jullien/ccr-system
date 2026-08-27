/**
 * Lecture des runs historiques dans le vocabulaire V2.1 (V0.3, §14).
 *
 * Projeter, c'est **nommer** les acteurs d'un run passé. Ce n'est pas
 * prétendre qu'il a suivi des règles qui n'existaient pas encore : la direction
 * réelle des transferts V2 venait du fournisseur opposé, jamais du rôle
 * déclaré. Un run projeté conserve donc sa sémantique d'exécution d'origine.
 *
 * Fonction pure : aucune lecture, aucune écriture, aucun fichier modifié.
 */

import type { ExpertSlots } from './run-native.ts';
import type { AgentRole, RunManifest } from './run.ts';

/**
 * Classification d'un manifest historique.
 *
 * Le troisième cas — rôle absent ou hors union — n'apparaît pas ici : il est
 * déjà rejeté en `MANIFEST_INVALID` par la validation historique, et le run est
 * illisible aujourd'hui comme il l'était hier.
 */
export type LegacyRoleMapping =
  | {
      readonly kind: 'LEGACY_PROJECTABLE';
      /**
       * Rappel porté par la valeur elle-même, pour qu'aucun appelant ne puisse
       * lire la projection sans lire ce qu'elle ne dit pas.
       */
      readonly execution_semantics: 'LEGACY_V2';
      readonly experts: ExpertSlots;
    }
  | {
      readonly kind: 'LEGACY_ROLE_MAPPING_CONFLICT';
      /** Le rôle déclaré deux fois. Aucun second rôle n'est inventé. */
      readonly duplicated_role: AgentRole;
    };

/**
 * Classe un manifest historique sans jamais inventer un rôle.
 *
 * Le slot vient du **rôle déclaré**, le moteur vient de la **clé d'agent**.
 * Jamais l'inverse : déduire le slot du fournisseur reproduirait exactement le
 * couplage que V2.1 supprime.
 */
export function classifyLegacyRoleMapping(manifest: RunManifest): LegacyRoleMapping {
  const { claude, codex } = manifest.agents;

  if (claude.role === codex.role) {
    return { kind: 'LEGACY_ROLE_MAPPING_CONFLICT', duplicated_role: claude.role };
  }

  const bySlot = {
    [claude.role]: { provider: 'claude' as const, session_id: claude.session_id },
    [codex.role]: { provider: 'codex' as const, session_id: codex.session_id },
  };

  // Les rôles étant distincts et l'union n'en comptant que deux, les deux
  // entrées existent. L'assertion est portée par la branche ci-dessus.
  const author = bySlot['author'];
  const challenger = bySlot['challenger'];
  if (author === undefined || challenger === undefined) {
    throw new Error('classifyLegacyRoleMapping : rôles distincts mais projection incomplète.');
  }

  return {
    kind: 'LEGACY_PROJECTABLE',
    execution_semantics: 'LEGACY_V2',
    experts: { author, challenger },
  };
}
