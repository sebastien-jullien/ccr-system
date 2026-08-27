/**
 * Effet d'une opération du cockpit sur les invocations CCR (`V2.3-S1`).
 *
 * ## Ce que ce module est
 *
 * Une primitive **partagée**, qui répond à deux questions et à deux seulement :
 *
 * ```text
 * cette opération peut-elle appeler un fournisseur ?
 * combien d'invocations CCR peut-elle engager ?
 * ```
 *
 * Elle ne décide rien. Elle ne consulte aucune politique, ne lit aucun journal,
 * n'admet ni ne refuse. Une opération dont l'effet vaut `EXACT(1)` reste
 * parfaitement refusable par le quota : ce sont deux faits séparés, et les
 * confondre reviendrait à faire de la présentation une autorité d'admission.
 *
 * ## Ce qui fait autorité
 *
 * Un marqueur unique distingue un chemin qui engage une invocation :
 * l'appel à `assertInvocationQuotaAvailable` avant tout fait durable. Ce
 * compteur **est** l'unité que CCR s'engage à consommer, et les trois services
 * natifs qui le portent sont exactement les trois opérations
 * `may_call_provider = YES` ci-dessous.
 *
 * `NATIVE_OPERATION_SERVICE` publie cette correspondance pour qu'une garde
 * puisse la confronter aux sources réelles. Sans cette garde, la table
 * ci-dessous serait une copie qui divergerait au premier service ajouté ; avec
 * elle, c'est un miroir vérifié.
 *
 * ## Jamais un compte forcé
 *
 * `AT_MOST` existe parce que `START` ne consomme pas un nombre fixe : le quota
 * est vérifié **par slot manquant**, si bien qu'une initialisation partielle
 * n'en engage qu'une. Annoncer `EXACT(2)` serait faux, et annoncer un chiffre
 * là où CCR n'en connaît aucun le serait tout autant — d'où `UNKNOWN`.
 */

/**
 * Opérations que le cockpit peut présenter.
 *
 * `START` y figure comme **fait de la primitive**, pas comme opération d'un run
 * existant : un run déjà né ne se démarre pas. La projection de présentation
 * d'un run ne la transporte donc pas.
 */
export const COCKPIT_OPERATION_IDS = ['STEP', 'SEND', 'START', 'PAUSE', 'RESUME', 'HANDOFF'] as const;
export type CockpitOperationId = (typeof COCKPIT_OPERATION_IDS)[number];

/**
 * Trois états, et non un booléen.
 *
 * `NOT_AVAILABLE` n'est pas « non » : le handoff ouvre une session interactive
 * dans un terminal local, et le cockpit ne l'exécute pas. Répondre « non » à
 * son sujet laisserait croire qu'il est inoffensif ; répondre « oui » qu'il est
 * déclenchable d'ici. Ni l'un ni l'autre n'est vrai.
 */
export type ProviderCallability = 'YES' | 'NO' | 'NOT_AVAILABLE';

/** Ce qu'une opération peut engager, jamais ce qu'elle engagera. */
export type InvocationEffect =
  | { readonly kind: 'EXACT'; readonly count: number }
  | { readonly kind: 'AT_MOST'; readonly count: number }
  | { readonly kind: 'UNKNOWN' };

export interface OperationEffect {
  readonly operation: CockpitOperationId;
  readonly may_call_provider: ProviderCallability;
  readonly invocation_effect: InvocationEffect;
}

/**
 * Service natif qui porte le chemin d'exécution de chaque opération.
 *
 * Publié pour être **confronté aux sources**, jamais pour être cru sur parole.
 */
export const NATIVE_OPERATION_SERVICE: Readonly<Record<CockpitOperationId, string>> = {
  STEP: 'native-step-service.ts',
  SEND: 'native-send-service.ts',
  START: 'native-start-service.ts',
  PAUSE: 'native-control-service.ts',
  RESUME: 'native-control-service.ts',
  HANDOFF: 'native-handoff-service.ts',
};

const EXACT = (count: number): InvocationEffect => ({ kind: 'EXACT', count });
const AT_MOST = (count: number): InvocationEffect => ({ kind: 'AT_MOST', count });
const UNKNOWN: InvocationEffect = { kind: 'UNKNOWN' };

const EFFECTS: Readonly<Record<CockpitOperationId, OperationEffect>> = {
  // Un transfert : une vérification de quota, un dispatch, un tour.
  STEP: { operation: 'STEP', may_call_provider: 'YES', invocation_effect: EXACT(1) },
  // Un envoi humain : la même chose, ciblée sur un slot.
  SEND: { operation: 'SEND', may_call_provider: 'YES', invocation_effect: EXACT(1) },
  // Une vérification **par slot manquant** : deux à la naissance, une lorsqu'une
  // initialisation partielle ne laisse qu'un slot à compléter.
  START: { operation: 'START', may_call_provider: 'YES', invocation_effect: AT_MOST(2) },
  // Contrôle humain : aucun adapter, aucune vérification de quota, aucun tour.
  PAUSE: { operation: 'PAUSE', may_call_provider: 'NO', invocation_effect: EXACT(0) },
  RESUME: { operation: 'RESUME', may_call_provider: 'NO', invocation_effect: EXACT(0) },
  // Non exécutable depuis le cockpit : ce qu'une session interactive consommera
  // ensuite n'appartient pas à CCR, et aucun chiffre ne serait honnête.
  HANDOFF: { operation: 'HANDOFF', may_call_provider: 'NOT_AVAILABLE', invocation_effect: UNKNOWN },
};

/** Effet d'une opération. Pur, total, sans I/O. */
export function operationEffect(operation: CockpitOperationId): OperationEffect {
  return EFFECTS[operation];
}

/** Opérations déclarées comme engageant réellement un fournisseur. */
export function providerProducingOperations(): readonly CockpitOperationId[] {
  return COCKPIT_OPERATION_IDS.filter((id) => EFFECTS[id].may_call_provider === 'YES');
}
