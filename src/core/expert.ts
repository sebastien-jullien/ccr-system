/**
 * Identités du protocole V2.1 (spécification V2.1 V0.3, §7, §8, §9).
 *
 * Deux vocabulaires, volontairement disjoints :
 *
 *   ExpertSlotId   QUI agit dans CCR        author | challenger
 *   ProviderKind   AVEC QUEL moteur         claude | codex
 *
 * La leçon de V2 tient en une phrase : le fournisseur n'est pas l'expert. Un
 * run peut employer deux fois le même moteur ; il possède toujours exactement
 * un `author` et un `challenger`.
 *
 * Ce module ne contient aucune règle d'affectation. Le défaut produit
 * (`author = codex`, `challenger = claude`) appartient aux bindings de
 * création, jamais au type : un helper qui le coderait rendrait le protocole à
 * nouveau dépendant du fournisseur.
 *
 * `AgentKind` (`src/core/run.ts`) subsiste comme type **legacy**,
 * provider-couplé, employé par les chemins d'exécution non encore migrés. Il
 * n'est pas l'ancêtre de `ProviderKind` : ce sont deux lectures différentes de
 * la même chaîne, l'une désignant un acteur du protocole V2, l'autre un moteur.
 */

/** Clé d'un slot d'expert. La clé **est** le rôle (V0.3, §9.3, §13.3). */
export const EXPERT_SLOT_IDS = ['author', 'challenger'] as const;
export type ExpertSlotId = (typeof EXPERT_SLOT_IDS)[number];

/** Union fermée des moteurs supportés. Valeurs de fil, en minuscules (V0.3, §8). */
export const PROVIDER_KINDS = ['claude', 'codex'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/**
 * Garde de typage — `ExpertSlotId` et `ProviderKind` n'ont aucune valeur
 * commune.
 *
 * Ce n'est pas une décoration : élargir l'un des deux vocabulaires jusqu'à les
 * faire se recouvrir — un slot nommé `claude`, un provider nommé `author` —
 * casse le `typecheck` ici, avant que la confusion n'atteigne un document
 * persisté. Une recherche de chaînes ne prouverait rien de tel.
 */
type Assert<T extends true> = T;
type Disjoint<A, B> = [A & B] extends [never] ? true : false;
export type ExpertSlotIdIsNotProviderKind = Assert<Disjoint<ExpertSlotId, ProviderKind>>;

export function isExpertSlotId(value: unknown): value is ExpertSlotId {
  return value === 'author' || value === 'challenger';
}

export function isProviderKind(value: unknown): value is ProviderKind {
  return value === 'claude' || value === 'codex';
}

/**
 * L'autre slot du run.
 *
 * Bijectif par construction, et sans équivalent provider : `counterpartOf`
 * (`src/services/transfer.ts`) répond « l'autre fournisseur », ce qui n'a pas
 * de cible lorsque les deux experts partagent le même moteur.
 */
export function otherExpertSlot(slot: ExpertSlotId): ExpertSlotId {
  return slot === 'author' ? 'challenger' : 'author';
}
