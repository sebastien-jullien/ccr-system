/**
 * Intention de production d'un run natif (P3).
 *
 * Ce module est **pur** : il ne lit aucun fichier, n'écrit rien, ne prend aucun
 * verrou et n'appelle aucun fournisseur. Il dérive un seul fait, depuis le seul
 * journal durable, et ne le persiste nulle part.
 *
 * ```text
 * L'INTENTION N'EST PAS UN ÉTAT PERSISTÉ
 * elle est DÉRIVÉE du journal append-only, à chaque lecture
 * ```
 *
 * C'est délibéré. Un état matérialisé aurait pu diverger du journal, et il
 * aurait fallu inventer une règle disant lequel des deux fait foi. Le journal
 * étant l'autorité durable, la dérivation ne peut pas se contredire.
 *
 * ## Ce que le fait signifie, et rien de plus
 *
 * ```text
 * NO_STEPS_INTENDED
 *   = l'autorité de contrôle humaine a délibérément déclaré qu'aucun pas de
 *     production natif supplémentaire n'est PRÉSENTEMENT prévu pour ce run
 *
 * STEPS_INTENDED
 *   = P3 lui-même n'interdit pas de pas de production natif supplémentaire
 * ```
 *
 * ## Asymétrie, et elle est voulue
 *
 * ```text
 * NO_STEPS_INTENDED   →   P3 refuse l'admission d'un pas
 * STEPS_INTENDED      ≠   pas actuellement admissible
 * ```
 *
 * `STEPS_INTENDED` est une **non-interdiction**, jamais une autorisation. Le
 * quota, la machine d'état, le propriétaire du contrôle, les conditions de
 * transfert et les autres gardes d'admission natives continuent de s'appliquer,
 * chacune pour son compte. P3 n'en court-circuite aucune, et n'en remplace
 * aucune.
 *
 * ## Non-affirmations
 *
 * ```text
 * NO_STEPS_INTENDED   ≠ run terminé            ≠ CLOSED
 *                     ≠ candidat correct       ≠ candidat complet
 *                     ≠ vainqueur désigné      ≠ accord d'un expert
 *                     ≠ convergence            ≠ controverse résolue
 *                     ≠ travail épuisé         ≠ quota épuisé
 *                     ≠ absence de source transférable
 * ```
 *
 * En particulier, un run peut simultanément porter `NO_STEPS_INTENDED` et une
 * source transférable en attente : ce sont deux faits distincts, et aucun des
 * deux ne dit quoi que ce soit de l'autre.
 */

import { PRODUCTION_INTENT_EVENT_TYPES } from './run-native.ts';
import type { NativeCcrEvent } from './run-native.ts';

/** Vocabulaire fermé de l'intention de production. Aucune valeur hors liste. */
export const PRODUCTION_INTENTS = ['STEPS_INTENDED', 'NO_STEPS_INTENDED'] as const;

export type ProductionIntent = (typeof PRODUCTION_INTENTS)[number];

/**
 * Intention par défaut, en l'absence de tout fait P3 applicable.
 *
 * Ce n'est pas une valeur de repli choisie faute de mieux : un run dont
 * personne n'a jamais déclaré la fin de production n'est pas un run dont la
 * production est déclarée finie. L'absence de déclaration est un fait exact.
 */
export const DEFAULT_PRODUCTION_INTENT: ProductionIntent = 'STEPS_INTENDED';

function isProductionIntentEvent(event: NativeCcrEvent): boolean {
  return (PRODUCTION_INTENT_EVENT_TYPES as readonly string[]).includes(event.type);
}

/**
 * Existe-t-il déjà un fait P3 durable dans ce journal ?
 *
 * Sert exactement une question, celle de la frontière de compatibilité : le
 * premier fait P3 rend le journal illisible par un binaire antérieur, les
 * suivants ne changent plus rien à cela.
 *
 * ```text
 * FRONTIÈRE   =   PREMIER FAIT P3 DURABLE
 * ```
 */
export function hasProductionIntentFact(events: readonly NativeCcrEvent[]): boolean {
  return events.some(isProductionIntentEvent);
}

/**
 * Intention courante, dérivée du **dernier** fait P3 applicable.
 *
 * « Dernier » se lit dans l'ordre append-only du journal, et nulle part
 * ailleurs : ni horodatage, ni round, ni identifiant lexical. Les opérations
 * sont sérialisées par le verrou de run ; l'ordre du journal est la preuve.
 *
 * Une réactivation ne supprime ni ne réécrit le fait de fin qui la précède :
 * l'histoire reste entière, et seule la lecture avance.
 */
export function deriveProductionIntent(events: readonly NativeCcrEvent[]): ProductionIntent {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined) continue;
    if (event.type === 'production_ended') return 'NO_STEPS_INTENDED';
    if (event.type === 'production_reactivated') return 'STEPS_INTENDED';
  }
  return DEFAULT_PRODUCTION_INTENT;
}
