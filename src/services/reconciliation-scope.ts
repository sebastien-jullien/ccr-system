/**
 * Périmètre V5 — validation d'appartenance et énumération de `WHOLE`.
 *
 * Tranche S4 du plan gelé. Ce module fournit les **primitives de périmètre
 * autoritaire** ; il n'écrit aucun enregistrement, n'acquiert aucun verrou, ne
 * calcule aucune actualité et ne produit aucun acte.
 *
 * ```text
 * VALIDATION PRIMITIVE  ≠  BUSINESS MUTATION
 * SCOPE VALIDITY        ≠  DECISION CURRENTNESS
 * ```
 *
 * ## Aucun verrou pris ici
 *
 * Le verrou de run n'est pas réentrant. Si ce module l'acquérait, le service de
 * mutation qui l'appelle ensuite le reprendrait et échouerait sur son propre
 * verrou. La conduite est donc l'inverse : **l'appelant fournit l'instantané
 * autoritaire** contre lequel valider, et c'est lui qui décide sous quelle
 * frontière il l'a obtenu.
 *
 * > **Précondition de mutation** : un appelant qui valide un périmètre pour
 * > l'écrire doit avoir lu cet instantané sous le verrou qu'il détient. Ce
 * > module ne peut pas le vérifier, et ne prétend pas le faire.
 *
 * ## Ce que ce module ne fait jamais
 *
 * ```text
 * VALIDATION  ≠  SCOPE AUTHORSHIP
 * VALIDATION  ≠  REPAIR
 * ```
 *
 * Il ne réduit pas un périmètre invalide, n'en élargit aucun, n'invente aucun
 * `SUBSET`, ne remplace pas une unité invalide, ne déplace pas une entrée
 * étrangère vers la bonne controverse, et ne calcule **jamais** l'intersection
 * de deux périmètres pour reconstruire une intention humaine. Un échec fait
 * refuser l'ensemble, jamais retenir une partie.
 */

import { CcrError } from '../core/errors.ts';
import { isControversyEntryId, isControversyId } from '../core/reconciliation.ts';
import type { ScopeKind } from '../core/reconciliation.ts';
import type { NativeRunSnapshot } from '../store/native-run-snapshot.ts';

/**
 * Motifs de refus de périmètre — union fermée.
 *
 * Le vocabulaire est **local au périmètre** : aucun motif de fraîcheur n'y
 * figure, et aucune issue métier (`RECORDED`, `REVALIDATION_REFUSED`,
 * `PROVIDER_FAILED`…) n'est produite ici. Une révision périmée et un périmètre
 * invalide sont deux raisons de refus distinctes, et ce module n'en connaît
 * qu'une.
 *
 * ```text
 * STALE REVISION  ≠  INVALID SCOPE
 * ```
 */
export const SCOPE_REFUSAL_REASONS = [
  'TARGET_NOT_CANONICAL',
  'TARGET_NOT_FOUND',
  'SCOPE_ABSENT',
  'SCOPE_EMPTY',
  'SCOPE_ENTRY_NOT_CANONICAL',
  'SCOPE_ENTRY_DUPLICATED',
  'SCOPE_ENTRY_NOT_FOUND',
  'SCOPE_ENTRY_FOREIGN',
] as const;
export type ScopeRefusalReason = (typeof SCOPE_REFUSAL_REASONS)[number];

function refuse(
  reason: ScopeRefusalReason,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): CcrError {
  return new CcrError('INVALID_ARGUMENT', message, { details: { reason, ...details } });
}

// --------------------------------------------------------------------------
// État V3 observé
// --------------------------------------------------------------------------

/**
 * Les unités de la controverse cible, **dans l'ordre autoritaire du journal V3**.
 *
 * L'appartenance est lue sur le champ canonique `controversy_id` de chaque
 * entrée V3 : jamais reconstruite depuis un texte humain, une provenance, un
 * `scope` textuel legacy ou une heuristique.
 *
 * L'ordre est celui du journal — aucun tri par identifiant ni par horodatage
 * n'est appliqué. Il est reproductible parce que le serveur le fixe, non parce
 * qu'un consommateur le range.
 *
 * ```text
 * ORDER  ≠  PREFERENCE
 * ```
 */
function entriesOfControversy(
  snapshot: NativeRunSnapshot,
  controversyId: string,
): readonly string[] {
  const ids: string[] = [];
  for (const entry of snapshot.controversies) {
    if (entry.controversy_id === controversyId) ids.push(entry.entry_id);
  }
  return ids;
}

/**
 * La controverse est-elle observable dans l'instantané ?
 *
 * Le contrat §6.5 (`CR5-12`) constate qu'une controverse canonique observable
 * est portée par au moins une `ctve_`. L'existence se lit donc exactement ainsi,
 * sur l'état V3 canonique de l'instantané : aucune projection, aucun read model.
 */
function controversyIsObservable(snapshot: NativeRunSnapshot, controversyId: string): boolean {
  return snapshot.controversies.some((entry) => entry.controversy_id === controversyId);
}

// --------------------------------------------------------------------------
// `WHOLE` — énumération
// --------------------------------------------------------------------------

/**
 * Énumère `WHOLE` contre l'instantané **fourni**, et rien d'autre — `V07`.
 *
 * ```text
 * WHOLE = l'ensemble des ctve_ de la controverse cible, tel qu'observé dans
 *         l'instantané autoritaire sur lequel l'acte est validé
 * ```
 *
 * L'énumération produite est **bornée par cet instantané**. Une `ctve_` créée
 * après cette observation n'y entre jamais, et aucune relecture ultérieure ne
 * l'y ajoute rétroactivement : le périmètre d'un acte est fixé à sa validation
 * et immuable.
 *
 * ```text
 * HISTORICAL WHOLE IS SNAPSHOT-BOUNDED
 * ```
 *
 * `WHOLE` n'est représenté ni par l'absence de périmètre, ni par un tableau
 * vide, ni par une convention implicite : cette fonction rend une énumération
 * explicite, que l'appelant enregistrera telle quelle.
 *
 * Une controverse observable porte au moins une entrée (§6.5). Si l'énumération
 * était néanmoins vide, `EMPTY_SCOPE = INVALID` (§6.1) s'applique sans
 * exception — le contrat n'en prévoit aucune, et ce module n'en invente pas.
 */
export function enumerateWholeScope(
  snapshot: NativeRunSnapshot,
  controversyId: string,
): readonly string[] {
  if (!isControversyId(controversyId)) {
    throw refuse(
      'TARGET_NOT_CANONICAL',
      `target non canonique : ${String(controversyId)}. Une cible V5 est une controverse \`ctv_\`.`,
      { controversy_id: controversyId },
    );
  }
  if (!controversyIsObservable(snapshot, controversyId)) {
    throw refuse(
      'TARGET_NOT_FOUND',
      `La controverse ${controversyId} n'est pas observable dans cet instantané.`,
      { controversy_id: controversyId },
    );
  }

  const enumerated = entriesOfControversy(snapshot, controversyId);
  if (enumerated.length === 0) {
    throw refuse(
      'SCOPE_EMPTY',
      `WHOLE sur ${controversyId} n'énumère aucune unité : EMPTY_SCOPE = INVALID (§6.1).`,
      { controversy_id: controversyId },
    );
  }
  return enumerated;
}

// --------------------------------------------------------------------------
// Validation d'un périmètre déclaré
// --------------------------------------------------------------------------

/** Ce qu'un appelant soumet à la validation. */
export interface ScopeValidationInput {
  readonly target_controversy_id: string;
  readonly scope_kind: ScopeKind;
  /**
   * Énumération déclarée. `undefined` est un cas de refus explicite, jamais un
   * signal de « périmètre entier » : `WHOLE` ne se représente pas par l'absence.
   */
  readonly scope: readonly string[] | undefined;
}

/**
 * Valide un périmètre déclaré contre l'instantané fourni — `V02` à `V07`.
 *
 * Ordre des contrôles, tel que le §6.4 l'énonce :
 *
 * ```text
 * 1  identité canonique de la cible, puis son existence observable
 * 2  périmètre présent et non vide
 * 3  identité canonique de chaque unité
 * 4  aucun doublon dans l'énumération
 * 5  chaque unité existe dans l'instantané autoritaire
 * 6  chaque unité appartient à la controverse cible
 * ```
 *
 * Un échec fait **refuser l'acte entier**, jamais retenir un périmètre partiel.
 *
 * Le périmètre est rendu **tel qu'il a été déclaré**, dans l'ordre de
 * déclaration : cette fonction ne le réordonne pas, ne le complète pas et ne le
 * réduit pas. Un `SUBSET` qui couvre par hasard toutes les unités courantes
 * reste un `SUBSET` — c'est la déclaration qui gouverne, pas la coïncidence.
 */
export function validateDeclaredScope(
  snapshot: NativeRunSnapshot,
  input: ScopeValidationInput,
): readonly string[] {
  if (!isControversyId(input.target_controversy_id)) {
    throw refuse(
      'TARGET_NOT_CANONICAL',
      `target non canonique : ${String(input.target_controversy_id)}.`,
      { controversy_id: input.target_controversy_id },
    );
  }
  if (!controversyIsObservable(snapshot, input.target_controversy_id)) {
    throw refuse(
      'TARGET_NOT_FOUND',
      `La controverse ${input.target_controversy_id} n'est pas observable dans cet instantané.`,
      { controversy_id: input.target_controversy_id },
    );
  }

  // `V03` — présent et non vide. L'absence est refusée POUR LES DEUX sortes :
  // `WHOLE` ne se représente jamais par un périmètre manquant (§6.3).
  if (input.scope === undefined) {
    throw refuse(
      'SCOPE_ABSENT',
      "Le périmètre est absent. WHOLE ne se représente ni par l'absence, ni par une convention implicite (§6.3).",
      { scope_kind: input.scope_kind },
    );
  }
  if (input.scope.length === 0) {
    throw refuse('SCOPE_EMPTY', 'Le périmètre est vide : EMPTY_SCOPE = INVALID (§6.1).', {
      scope_kind: input.scope_kind,
    });
  }

  const known = new Map<string, string>();
  for (const entry of snapshot.controversies) known.set(entry.entry_id, entry.controversy_id);

  const seen = new Set<string>();
  for (const [index, unit] of input.scope.entries()) {
    // `V01` de forme, appliqué à l'unité de périmètre.
    if (!isControversyEntryId(unit)) {
      throw refuse(
        'SCOPE_ENTRY_NOT_CANONICAL',
        `scope[${String(index)}] n'est pas une identité \`ctve_\` canonique : ${String(unit)}.`,
        { position: index, entry_id: unit },
      );
    }
    // `V04` — aucun doublon. Deux occurrences ne renforcent rien ; elles rendent
    // l'énumération ambiguë.
    if (seen.has(unit)) {
      throw refuse('SCOPE_ENTRY_DUPLICATED', `scope[${String(index)}] est dupliqué : ${unit}.`, {
        position: index,
        entry_id: unit,
      });
    }
    seen.add(unit);

    // `V06` — l'unité existe dans l'instantané autoritaire.
    const owner = known.get(unit);
    if (owner === undefined) {
      throw refuse(
        'SCOPE_ENTRY_NOT_FOUND',
        `scope[${String(index)}] n'existe pas dans cet instantané : ${unit}.`,
        { position: index, entry_id: unit },
      );
    }
    // `V05` — l'unité appartient à la controverse cible. Une entrée étrangère
    // est refusée, jamais déplacée vers sa controverse d'origine.
    if (owner !== input.target_controversy_id) {
      throw refuse(
        'SCOPE_ENTRY_FOREIGN',
        `scope[${String(index)}] appartient à ${owner}, non à ${input.target_controversy_id}.`,
        { position: index, entry_id: unit, owner, target: input.target_controversy_id },
      );
    }
  }

  return input.scope;
}

/**
 * Prépare le périmètre d'un acte à venir, `SUBSET` comme `WHOLE`.
 *
 * Pour `WHOLE`, l'énumération est produite contre l'instantané fourni puis
 * validée par le même chemin que n'importe quel périmètre déclaré : il n'existe
 * pas deux jeux de règles, et une énumération serveur ne bénéficie d'aucune
 * dispense.
 *
 * Le résultat est **une énumération explicite**, destinée à être enregistrée
 * telle quelle sur l'acte. Ce module ne l'écrit pas.
 */
export function prepareScope(
  snapshot: NativeRunSnapshot,
  input: ScopeValidationInput,
): readonly string[] {
  const declared =
    input.scope_kind === 'WHOLE' && input.scope === undefined
      ? enumerateWholeScope(snapshot, input.target_controversy_id)
      : input.scope;

  return validateDeclaredScope(snapshot, { ...input, scope: declared });
}

// --------------------------------------------------------------------------
// `C29` — deux faits distincts, jamais confondus
// --------------------------------------------------------------------------

/**
 * Toutes les unités **actuellement observées** d'une controverse sont-elles
 * couvertes par l'énumération fournie ?
 *
 * C'est un fait **structurel**, calculé sur un instantané, et rien d'autre.
 *
 * ```text
 * STRUCTURAL COVERAGE  ≠  HUMAN WHOLE-CLOSURE DECISION
 * ```
 *
 * Il ne dit pas qu'un humain a déclaré une clôture sur `WHOLE`, ni qu'une
 * controverse serait « actuellement close ». Le contrat §17.2 sépare
 * définitivement les deux faits, et aucune règle ne convertit celui-ci en
 * l'autre. Un `SUBSET` qui les couvre toutes reste un `SUBSET`.
 */
export function coversAllObservedEntries(
  snapshot: NativeRunSnapshot,
  controversyId: string,
  scope: readonly string[],
): boolean {
  const observed = entriesOfControversy(snapshot, controversyId);
  if (observed.length === 0) return false;
  const covered = new Set(scope);
  return observed.every((entry) => covered.has(entry));
}
