/**
 * Effet d'une opération CCR sur les invocations CCR (`V2.3-S1`).
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
 * La frontière d'engagement est **une**, et ce n'est pas le contrôle de quota :
 *
 * ```text
 * CONTRÔLE DE QUOTA   ≠   ENGAGEMENT DURABLE D'INVOCATION
 * ```
 *
 * Un quota se vérifie **avant** l'engagement ; il peut refuser sans que rien ne
 * soit engagé, et il n'interdirait pas à un chemin d'engager deux fois. L'unité
 * que CCR s'engage à consommer est la ligne durable écrite au journal
 * d'invocations, et rien d'autre.
 *
 * Les services qui franchissent cette frontière sont exactement les opérations
 * `may_call_provider = YES` ci-dessous : trois services natifs côté cockpit,
 * trois services de domaine côté opérations assistées par modèle.
 *
 * `NATIVE_OPERATION_SERVICE` et `MODEL_ASSISTED_OPERATION_SERVICE` publient
 * cette correspondance pour que les gardes la confrontent aux sources réelles,
 * et la cardinalité publiée est éprouvée **à l'exécution** contre le nombre
 * d'engagements réellement franchis. Sans cela, la table ci-dessous serait une
 * copie qui divergerait au premier chemin ajouté ; avec, c'est un miroir vérifié.
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
 * Opérations de domaine assistées par modèle, demandées par un humain.
 *
 * Elles ne figurent **pas** dans `COCKPIT_OPERATION_IDS` : le cockpit ne les
 * présente pas, et son vocabulaire ne bouge pas. Elles portent pourtant le même
 * fait — ce qu'une opération peut engager en invocations CCR — et se lisent donc
 * par la même primitive, jamais par une seconde table.
 *
 * Ce sont des identités d'**opération**. Le vocabulaire de déclencheurs de la
 * comptabilité d'invocation nomme, lui, pourquoi un engagement a été fait ; les
 * deux ne se dérivent pas l'un de l'autre.
 */
export const MODEL_ASSISTED_OPERATION_IDS = ['DETECT', 'PROPOSE', 'ADDUCE_MODEL'] as const;
export type ModelAssistedOperationId = (typeof MODEL_ASSISTED_OPERATION_IDS)[number];

/** Toute opération dont cette primitive publie l'effet d'invocation. */
export type OperationId = CockpitOperationId | ModelAssistedOperationId;

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
  readonly operation: OperationId;
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

/**
 * Service de domaine qui porte le chemin d'exécution de chaque opération
 * assistée par modèle.
 *
 * Même usage que `NATIVE_OPERATION_SERVICE`, et même exigence : la table
 * ci-dessous doit être confrontée aux sources, jamais crue sur parole. Ces
 * services ne sont pas des `native-*-service.ts` ; ils appartiennent à leurs
 * domaines, et c'est pourquoi ils portent leur propre correspondance.
 */
export const MODEL_ASSISTED_OPERATION_SERVICE: Readonly<
  Record<ModelAssistedOperationId, string>
> = {
  DETECT: 'controversy-detector.ts',
  PROPOSE: 'reconciliation-proposer.ts',
  ADDUCE_MODEL: 'evidence-adducer.ts',
};

const EXACT = (count: number): InvocationEffect => ({ kind: 'EXACT', count });
const AT_MOST = (count: number): InvocationEffect => ({ kind: 'AT_MOST', count });
const UNKNOWN: InvocationEffect = { kind: 'UNKNOWN' };

const EFFECTS: Readonly<Record<OperationId, OperationEffect>> = {
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
  // Trois gestes humains, chacun sur un périmètre nommé : une vérification de
  // quota, un engagement durable, un appel. Aucune multiplicité de créneau, et
  // aucun second appel — un périmètre plus large agrandit le contexte soumis,
  // jamais le nombre d'engagements.
  DETECT: { operation: 'DETECT', may_call_provider: 'YES', invocation_effect: EXACT(1) },
  PROPOSE: { operation: 'PROPOSE', may_call_provider: 'YES', invocation_effect: EXACT(1) },
  ADDUCE_MODEL: {
    operation: 'ADDUCE_MODEL',
    may_call_provider: 'YES',
    invocation_effect: EXACT(1),
  },
};

/** Effet d'une opération. Pur, total, sans I/O. */
export function operationEffect(operation: OperationId): OperationEffect {
  return EFFECTS[operation];
}

/**
 * Opérations du cockpit déclarées comme engageant réellement un fournisseur.
 *
 * Portée **cockpit**, délibérément : la garde qui consomme cette liste la
 * confronte aux `native-*-service.ts`. Les opérations assistées par modèle ont
 * leur propre accesseur, et leur propre garde.
 */
export function providerProducingOperations(): readonly CockpitOperationId[] {
  return COCKPIT_OPERATION_IDS.filter((id) => EFFECTS[id].may_call_provider === 'YES');
}

/** Opérations assistées par modèle déclarées comme engageant un fournisseur. */
export function modelAssistedProviderProducingOperations(): readonly ModelAssistedOperationId[] {
  return MODEL_ASSISTED_OPERATION_IDS.filter((id) => EFFECTS[id].may_call_provider === 'YES');
}
