/**
 * Proposition de réconciliation assistée par modèle — trois sections, un module.
 *
 * Tranche S13 du plan gelé. Le motif est celui d'`evidence-adducer.ts`,
 * transposé parce que le contrat V5 impose la même architecture — jamais par
 * analogie.
 *
 * ```text
 * 1/3  parseur strict PUR      borne d'octets AVANT JSON.parse, enveloppe
 *                              fermée, version explicite, refus nommé de chacun
 *                              des motifs du §36
 * 2/3  dispatch gouverné       PHASE A verrou court — périmètre, ensemble
 *                              soumis, quota, invocation_id, engagement durable,
 *                              R0, RELÂCHE
 *                              PHASE B hors verrou — UN appel, jamais deux
 *                              PHASE C verrou neuf — relecture, R1, revalidation
 *                              déterministe TOUT-OU-RIEN, puis append unique
 * 3/3  porte de disponibilité  service-autoritaire, initialement NOT_AVAILABLE
 * ```
 *
 * ```text
 * PROPOSAL                   ≠  DECISION
 * MODEL_ASSISTED             ≠  HUMAN
 * PROVIDER                   ≠  SEMANTIC ORIGIN        PROVIDER  ≠  AUTHORITY
 * VALID MODEL OUTPUT         ≠  TRUE OUTPUT            VALIDATION ≠ MERITS
 * OPTION ORDER               ≠  RANKING
 * ENGAGEMENT                 ≠  SUCCÈS
 * DISPATCH_COMMITTED         ≠  SUCCÈS
 * UNKNOWN_AFTER_COMMITMENT   ≠  PROVIDER_FAILED
 * R0 VALIDE                  ≠  R1 ENCORE VALIDE
 * EXISTE MAINTENANT          ≠  A ÉTÉ SOUMIS
 * ```
 *
 * ## Ce que le modèle ne peut pas faire
 *
 * Il ne choisit ni la cible, ni le fournisseur, ni le modèle, ni l'`invocation_id`,
 * ni l'origine sémantique, ni l'enregistreur, ni l'horodatage, ni la dérivation,
 * ni le `scope_kind`. Il **sélectionne** des unités dans l'ensemble que le
 * serveur lui a soumis, et propose des options. Sélectionner dans un ensemble
 * fourni n'est pas être l'auteur d'un périmètre.
 *
 * ```text
 * VALIDATION  ≠  SCOPE AUTHORSHIP
 * ```
 *
 * Il ne peut jamais pré-écrire un effet humain : `closure`, `closure_withdrawal`,
 * `supersedes`, `provenance`, `content` et `responds_to` sont refusés **par leur
 * nom** avant toute écriture, et le schéma fermé de `S1` les refuserait de toute
 * façon.
 */

import {
  RECONCILIATION_SCHEMA_VERSION,
  formatReconciliationId,
  validateReconciliationEntry,
} from '../core/reconciliation.ts';
import type {
  ProposalOption,
  ReconciliationEntry,
  ReconciliationProposedEntry,
  ScopeKind,
} from '../core/reconciliation.ts';
import { isControversyEntryId, isControversyId } from '../core/reconciliation.ts';
import { CcrError, isCcrError } from '../core/errors.ts';
import type { ExpertSlotId, ProviderKind } from '../core/expert.ts';
import { RECONCILIATION_PROPOSAL_TRIGGER } from '../core/usage-governance.ts';
import type { AgentAdapter, AgentTurnResult } from '../adapters/agent-adapter.ts';
import { runPaths } from '../store/layout.ts';
import { openInvocationLedger } from '../store/invocation-ledger.ts';
import { openUsageLedger } from '../store/usage-ledger.ts';
import {
  appendReconciliationEntries,
  readReconciliationJournal,
} from '../store/reconciliation-store.ts';
import { readStableNativeRunSnapshot } from '../store/native-run-snapshot.ts';
import type { NativeRunSnapshot } from '../store/native-run-snapshot.ts';
import { utf8ByteLength } from './transfer.ts';
import { assertInvocationQuotaAvailable } from './invocation-quota.ts';
import { createUsageRecorder, recordTurnUsage } from './usage-governance-writer.ts';
import { prepareScope, validateDeclaredScope } from './reconciliation-scope.ts';
import {
  assertProposalContextWithinBound,
  auditProposalContext,
  buildProposalContext,
  serializeProposalContext,
} from './reconciliation-proposal-context.ts';
import { runtimeSettingsOf } from './native-start-service.ts';
import type { RunRuntimeSettings } from './run-service.ts';
import { withNativeMutation } from './native-mutation-boundary.ts';
import { commitInvocationOutcome } from './invocation-outcome-writer.ts';

// ==========================================================================
// SECTION 1/3 — Parseur strict, PUR
// ==========================================================================

/** Version de l'enveloppe attendue du modèle. Sans rapport avec le journal V5. */
export const RECONCILIATION_PROPOSAL_OUTPUT_VERSION = 1;

/** Borne d'octets vérifiée **AVANT** l'analyse — §36, premier motif. */
export const MAX_PROPOSER_OUTPUT_BYTES = 1024 * 1024;

/** Une option proposée par le modèle. Deux champs, jamais trois. */
export interface ProposedReconciliationOption {
  readonly option_id: string;
  readonly content: string;
}

/** Une proposition retournée par le modèle. */
export interface ProposedReconciliation {
  /** Unités **sélectionnées** dans l'ensemble soumis — jamais inventées. */
  readonly scope: readonly string[];
  readonly options: readonly ProposedReconciliationOption[];
}

/**
 * Motifs de refus — **exactement** les quinze du §36, dans son ordre.
 *
 * Chaque motif est refusé avant toute écriture. Un champ interdit est nommé
 * plutôt qu'absorbé par le refus générique de champ inconnu : le motif rendu
 * doit dire ce qui a été tenté.
 */
export const PROPOSER_OUTPUT_REFUSAL_REASONS = [
  'OUTPUT_TOO_LARGE',
  'OUTPUT_UNPARSABLE',
  'UNSUPPORTED_VERSION',
  'INVALID_ENVELOPE',
  'INVALID_PROPOSAL',
  'DUPLICATE_PROPOSAL',
  'UNKNOWN_TARGET',
  'INVALID_SCOPE',
  'RANKED_OPTIONS',
  'SCORE_FIELD_PRESENT',
  'CLOSURE_CLAIMED',
  'CLOSURE_WITHDRAWAL_CLAIMED',
  'SUPERSESSION_CLAIMED',
  'HUMAN_DECISION_CLAIMED',
  'AUTHORITATIVE_EFFECT_CLAIMED',
] as const;
export type ProposerOutputRefusalReason = (typeof PROPOSER_OUTPUT_REFUSAL_REASONS)[number];

export type ReconciliationProposalParse =
  | { readonly outcome: 'VALID'; readonly proposals: readonly ProposedReconciliation[] }
  | {
      readonly outcome: 'INVALID';
      readonly reason: ProposerOutputRefusalReason;
      readonly at: string;
    };

function invalid(reason: ProposerOutputRefusalReason, at: string): ReconciliationProposalParse {
  return { outcome: 'INVALID', reason, at };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Champs de mérite — §26.1, `V30`. Leur seule présence est un refus nommé. */
const SCORE_FIELDS = [
  'score',
  'weight',
  'confidence',
  'probability',
  'priority',
  'severity',
  'certainty',
  'strength',
] as const;

/** Marqueurs de classement — §12, `V29`. */
const RANKING_FIELDS = [
  'rank',
  'ranked',
  'order',
  'position',
  'best',
  'best_option',
  'preferred',
  'preferred_option',
  'recommended',
  'recommended_option',
  'winner',
  'selected',
  'selected_option',
] as const;

/** Effets humains, refusés **par leur nom** — §11, `V10`. */
const CLAIMED_EFFECT_FIELDS: readonly (readonly [string, ProposerOutputRefusalReason])[] = [
  ['closure', 'CLOSURE_CLAIMED'],
  ['closure_withdrawal', 'CLOSURE_WITHDRAWAL_CLAIMED'],
  ['supersedes', 'SUPERSESSION_CLAIMED'],
  ['content', 'HUMAN_DECISION_CLAIMED'],
  ['provenance', 'HUMAN_DECISION_CLAIMED'],
  ['responds_to', 'AUTHORITATIVE_EFFECT_CLAIMED'],
  ['semantic_origin', 'AUTHORITATIVE_EFFECT_CLAIMED'],
  ['recorded_by', 'AUTHORITATIVE_EFFECT_CLAIMED'],
  ['entry_id', 'AUTHORITATIVE_EFFECT_CLAIMED'],
  ['derivation', 'AUTHORITATIVE_EFFECT_CLAIMED'],
  ['scope_kind', 'AUTHORITATIVE_EFFECT_CLAIMED'],
];

/**
 * Un champ interdit **nommé** est-il présent ? Le nom prime sur le générique.
 *
 * `exempt` porte les champs dont l'interdiction dépend du niveau. `content` en
 * est le seul cas : sur une enveloppe ou une proposition, c'est le contenu d'une
 * décision humaine et le §11 l'interdit ; sur une option, c'est le champ que le
 * §12 exige. Un même nom, deux sens — et les confondre refuserait toute sortie
 * valide.
 */
function claimedField(
  record: Record<string, unknown>,
  at: string,
  exempt: readonly string[] = [],
): ReconciliationProposalParse | null {
  for (const field of SCORE_FIELDS) {
    if (field in record) return invalid('SCORE_FIELD_PRESENT', `${at}.${field}`);
  }
  for (const field of RANKING_FIELDS) {
    if (field in record) return invalid('RANKED_OPTIONS', `${at}.${field}`);
  }
  for (const [field, reason] of CLAIMED_EFFECT_FIELDS) {
    if (exempt.includes(field)) continue;
    if (field in record) return invalid(reason, `${at}.${field}`);
  }
  return null;
}

function parseOption(
  value: unknown,
  at: string,
): ProposedReconciliationOption | ReconciliationProposalParse {
  if (!isPlainObject(value)) return invalid('INVALID_PROPOSAL', at);
  // `content` est ici le champ EXIGÉ par le §12, non un contenu de décision.
  const claimed = claimedField(value, at, ['content']);
  if (claimed !== null) return claimed;
  for (const key of Object.keys(value)) {
    if (key !== 'option_id' && key !== 'content') return invalid('INVALID_PROPOSAL', `${at}.${key}`);
  }
  const optionId = value['option_id'];
  const content = value['content'];
  if (typeof optionId !== 'string' || optionId.length === 0) {
    return invalid('INVALID_PROPOSAL', `${at}.option_id`);
  }
  if (typeof content !== 'string' || content.length === 0) {
    return invalid('INVALID_PROPOSAL', `${at}.content`);
  }
  return { option_id: optionId, content };
}

function parseProposal(
  value: unknown,
  at: string,
): ProposedReconciliation | ReconciliationProposalParse {
  if (!isPlainObject(value)) return invalid('INVALID_PROPOSAL', at);
  const claimed = claimedField(value, at);
  if (claimed !== null) return claimed;
  for (const key of Object.keys(value)) {
    if (key !== 'scope' && key !== 'options') return invalid('INVALID_PROPOSAL', `${at}.${key}`);
  }

  const scope = value['scope'];
  if (!Array.isArray(scope) || scope.length === 0) return invalid('INVALID_SCOPE', `${at}.scope`);
  const seenUnits = new Set<string>();
  for (const [index, unit] of scope.entries()) {
    if (!isControversyEntryId(unit)) return invalid('INVALID_SCOPE', `${at}.scope[${String(index)}]`);
    if (seenUnits.has(unit as string)) {
      return invalid('INVALID_SCOPE', `${at}.scope[${String(index)}]`);
    }
    seenUnits.add(unit as string);
  }

  const options = value['options'];
  if (!Array.isArray(options) || options.length === 0) {
    return invalid('INVALID_PROPOSAL', `${at}.options`);
  }
  const parsed: ProposedReconciliationOption[] = [];
  const seenOptions = new Set<string>();
  for (const [index, option] of options.entries()) {
    const result = parseOption(option, `${at}.options[${String(index)}]`);
    if ('outcome' in result) return result;
    if (seenOptions.has(result.option_id)) {
      // `V29` — une identité dupliquée rendrait `adopted_option_id` ambigu.
      return invalid('INVALID_PROPOSAL', `${at}.options[${String(index)}].option_id`);
    }
    seenOptions.add(result.option_id);
    parsed.push(result);
  }

  // L'ordre du modèle est conservé tel quel. Aucun tri, aucune mise en avant.
  return { scope: scope as readonly string[], options: parsed };
}

/**
 * Analyse la sortie brute du modèle — fonction **pure**, autorité unique de
 * forme.
 *
 * ```text
 * borne d'octets vérifiée AVANT l'analyse
 * enveloppe fermée, version explicite
 * ensemble de propositions clos
 * aucune valeur inconnue tolérée
 * ```
 *
 * Aucune réparation silencieuse : rien n'est complété, renommé, supprimé,
 * réordonné ni réécrit pour sauver une sortie. Un refus est un refus.
 *
 * ```text
 * RAW MODEL OUTPUT  ≠  CANONICAL V5 HISTORY
 * ```
 *
 * @param raw            la sortie du fournisseur, telle quelle
 * @param expectedTarget la controverse que le SERVEUR a choisie
 */
export function parseReconciliationProposals(
  raw: string,
  expectedTarget: string,
): ReconciliationProposalParse {
  // §36, motif 1 — la borne précède l'analyse. Analyser d'abord reviendrait à
  // faire payer le coût que la borne existe pour éviter.
  if (utf8ByteLength(raw) > MAX_PROPOSER_OUTPUT_BYTES) {
    return invalid('OUTPUT_TOO_LARGE', 'output');
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return invalid('OUTPUT_UNPARSABLE', 'output');
  }

  if (!isPlainObject(value)) return invalid('INVALID_ENVELOPE', 'envelope');
  const claimed = claimedField(value, 'envelope');
  if (claimed !== null) return claimed;
  for (const key of Object.keys(value)) {
    if (key !== 'version' && key !== 'target_controversy_id' && key !== 'proposals') {
      return invalid('INVALID_ENVELOPE', `envelope.${key}`);
    }
  }
  if (value['version'] !== RECONCILIATION_PROPOSAL_OUTPUT_VERSION) {
    return invalid('UNSUPPORTED_VERSION', 'envelope.version');
  }

  const target = value['target_controversy_id'];
  if (!isControversyId(target) || target !== expectedTarget) {
    return invalid('UNKNOWN_TARGET', 'envelope.target_controversy_id');
  }

  const proposals = value['proposals'];
  if (!Array.isArray(proposals)) return invalid('INVALID_ENVELOPE', 'envelope.proposals');

  const parsed: ProposedReconciliation[] = [];
  const seen = new Set<string>();
  for (const [index, proposal] of proposals.entries()) {
    const at = `proposals[${String(index)}]`;
    const result = parseProposal(proposal, at);
    if ('outcome' in result) return result;
    // Identité de proposition : son périmètre et l'ensemble de ses options.
    const identity = JSON.stringify([
      result.scope,
      result.options.map((option) => [option.option_id, option.content]),
    ]);
    if (seen.has(identity)) return invalid('DUPLICATE_PROPOSAL', at);
    seen.add(identity);
    parsed.push(result);
  }

  return { outcome: 'VALID', proposals: parsed };
}

// ==========================================================================
// SECTION 2/3 — Dispatch gouverné, trois phases
// ==========================================================================

export interface ProposalAdapters {
  readonly claude: AgentAdapter;
  readonly codex: AgentAdapter;
}

export interface ReconciliationProposerDeps {
  readonly runsDir: string;
  now(): Date;
  createAdapters(cwd: string, runtime?: RunRuntimeSettings): ProposalAdapters;
}

/**
 * Le geste humain, tel qu'il est nommé.
 *
 * L'appelant nomme la controverse et le périmètre soumis. Il ne choisit
 * **jamais** le fournisseur, le modèle, l'`invocation_id`, l'origine sémantique,
 * l'enregistreur, l'horodatage ni la dérivation. `expert_slot` désigne le moteur
 * qui exécutera ; CCR en dérive le fournisseur depuis le manifest.
 */
export interface ReconciliationProposalRequest {
  readonly runId: string;
  readonly target_controversy_id: string;
  readonly scope_kind: ScopeKind;
  /** Absent avec `WHOLE` : le serveur énumère (§6.3). */
  readonly scope?: readonly string[];
  readonly expert_slot: ExpertSlotId;
}

/**
 * Les quatre contrôles de phase C, nommés.
 *
 * ```text
 * R0             la révision autoritaire relue a divergé de la référence
 * SCOPE          `S4` a refusé — porte V02 · V03 · V04 · V05 · V06
 * SUBMITTED_SET  un objet nommé n'appartient pas à l'ensemble soumis en phase A
 * CANONICAL_FORM la validation canonique a refusé — V01 · V08 · V09 · V29 · V30
 * ```
 */
export const PROPOSAL_REVALIDATION_CHECKS = [
  'R0',
  'SCOPE',
  'SUBMITTED_SET',
  'CANONICAL_FORM',
] as const;
export type ProposalRevalidationCheck = (typeof PROPOSAL_REVALIDATION_CHECKS)[number];

/**
 * Issue du chemin assisté — union discriminée, fermée.
 *
 * Le contrat §38.4 nomme `RECORDED`, jamais `SUCCESS` : un enregistrement a été
 * écrit, ni que la proposition soit bonne, ni qu'elle doive être suivie.
 *
 * `UNKNOWN_AFTER_COMMITMENT` **n'est pas une issue rendue** : c'est ce qui reste
 * lisible quand aucun retour n'existe — engagement présent au ledger, usage
 * absent, aucune proposition `MODEL_ASSISTED`. Le convertir en `PROVIDER_FAILED`
 * affirmerait que rien n'a été consommé, ce que CCR ignore précisément.
 *
 * Dans les cinq cas, l'invocation reste enregistrée. Un engagement durable ne
 * s'efface pas parce que la suite a échoué.
 */
export type ReconciliationProposalOutcome =
  | {
      readonly kind: 'RECORDED';
      readonly invocation_id: string;
      readonly entries: readonly ReconciliationProposedEntry[];
      readonly reconciliation_revision: string;
    }
  | { readonly kind: 'VALID_ZERO'; readonly invocation_id: string }
  | {
      readonly kind: 'INVALID_OUTPUT';
      readonly invocation_id: string;
      readonly reason: ProposerOutputRefusalReason;
      readonly at: string;
    }
  | {
      readonly kind: 'REVALIDATION_REFUSED';
      readonly invocation_id: string;
      readonly check: ProposalRevalidationCheck;
      readonly detail: string;
    }
  | {
      readonly kind: 'PROVIDER_FAILED';
      readonly invocation_id: string;
      readonly error_code: string;
    };

/** Coutures de test. Aucune production n'en fournit. */
export interface ReconciliationProposalSeams {
  /** Appelée quand le verrou de phase A est relâché, avant l'adaptateur. */
  readonly beforeProvider?: () => void | Promise<void>;
  readonly openInvocationLedger?: typeof openInvocationLedger;
  readonly openUsageLedger?: typeof openUsageLedger;
}

/**
 * Motifs de refus **avant tout engagement**.
 *
 * Un refus de périmètre ne coûte rien : zéro quota consommé, zéro
 * `invocation_id`, zéro ligne de ledger, zéro adaptateur construit, zéro appel.
 * Il n'est donc pas une des issues du §38.4, qui décrivent ce qui advient
 * lorsqu'un engagement a eu lieu.
 */
export const PROPOSAL_SCOPE_REFUSAL_REASON = 'PROPOSAL_SCOPE_REFUSED';

/** Ce que la phase A établit, et que les phases suivantes consomment. */
interface ProposalDispatchPlan {
  readonly invocationId: string;
  readonly provider: ProviderKind;
  readonly cwd: string;
  readonly runtime: RunRuntimeSettings | undefined;
  readonly prompt: string;
  /** L'ensemble **réellement soumis**, calculé par le serveur, jamais enrichi. */
  readonly submitted: readonly string[];
  /** `R0` — référence de fraîcheur de CETTE tentative, capturée sous verrou. */
  readonly r0: string;
  /** Taille mesurée du contexte canonique, déjà vérifiée contre la borne. */
  readonly contextBytes: number;
}

/**
 * La demande adressée au modèle.
 *
 * Elle décrit **exactement** le protocole que la section 1/3 accepte, et ne
 * demande **aucun verdict** : ni la meilleure option, ni un classement, ni un
 * gagnant, ni qui a raison, ni ce qui est vrai. Le modèle propose ; le système
 * valide une représentation, jamais un mérite.
 *
 * ```text
 * NO CHOOSE BEST · NO RANK · NO RECOMMEND · NO DECIDE · NO SELECT WINNER
 * ```
 */
export function buildProposalPrompt(
  targetControversyId: string,
  submitted: readonly string[],
  context: string,
): string {
  return [
    'Tu produis des PROPOSITIONS de réconciliation. Une proposition ne décide rien,',
    "ne clôt rien, ne supersède rien et ne retire rien : elle n'a aucun effet.",
    '',
    `Controverse : ${targetControversyId}`,
    'Unités soumises — tu ne peux en désigner aucune autre :',
    ...submitted.map((unit) => `  ${unit}`),
    '',
    // ---- Contexte canonique. Le prompt est AUTONOME : tout ce qui est
    // nécessaire pour comprendre le désaccord est ici. Rien ne demande d'aller
    // lire un fichier, d'inspecter un répertoire ni de deviner un chemin.
    context,
    '',
    "Ce contexte est fourni pour la lecture. Les événements ancrés et les preuves",
    "versées ne sont PAS des unités soumises : ils éclairent les unités, et une",
    'proposition ne peut porter que sur les unités listées ci-dessus.',
    '',
    "Une preuve versée n'est pas une vérité, et n'est pas une validation du fond.",
    "Un plus grand nombre de matériaux ne rend aucune position plus forte. Une",
    "orientation est une relation déclarée dans le débat, jamais un jugement de",
    "CCR. L'ordre des éléments ne signifie ni rang, ni importance, ni préférence.",
    '',
    'Réponds UNIQUEMENT par ce JSON, sans texte autour :',
    '{',
    `  "version": ${String(RECONCILIATION_PROPOSAL_OUTPUT_VERSION)},`,
    `  "target_controversy_id": "${targetControversyId}",`,
    '  "proposals": [',
    '    { "scope": ["ctve_…"], "options": [ { "option_id": "…", "content": "…" } ] }',
    '  ]',
    '}',
    '',
    "N'ajoute aucun autre champ. Aucun score, aucun rang, aucune confiance, aucune",
    'recommandation, aucune option « meilleure », « préférée » ou « retenue ».',
    "L'ordre des options ne signifie rien. Ne revendique ni clôture, ni retrait,",
    'ni supersession, ni décision humaine.',
    '',
    'Un ensemble vide de propositions est une réponse valide.',
  ].join('\n');
}

/**
 * PHASE A — verrou court. Rien d'externe ne s'exécute dedans.
 *
 * Ordre exact :
 *
 * ```text
 * 1  instantané stable relu
 * 2  périmètre validé par S4 — ensemble soumis calculé par le SERVEUR
 * 3  R0 capturé, AVANT le dispatch
 * 4  quota — un refus n'atteint jamais un adaptateur
 * 5  invocation_id alloué
 * 6  engagement DURABLE écrit au ledger, AVANT toute tentative fournisseur
 * ```
 *
 * Un refus de périmètre lève ici, sans quota consommé et sans engagement.
 */
async function planProposal(
  deps: ReconciliationProposerDeps,
  request: ReconciliationProposalRequest,
  seams: ReconciliationProposalSeams,
): Promise<ProposalDispatchPlan> {
  const paths = runPaths(deps.runsDir, request.runId);

  return withNativeMutation(
    { runsDir: deps.runsDir, runId: request.runId, command: 'v5-propose-model-dispatch' },
    async () => {
      const snapshot = await readStableNativeRunSnapshot(deps.runsDir, request.runId);

      // ---- L'ensemble soumis, par le propriétaire du périmètre. `WHOLE` est
      // énuméré ici, borné à CET instantané, et jamais enrichi ensuite.
      const submitted = prepareScope(snapshot, {
        target_controversy_id: request.target_controversy_id,
        scope_kind: request.scope_kind,
        scope: request.scope,
      });

      // ---- Contexte canonique, depuis CE MÊME instantané — celui qui porte
      // `R0`. Le modèle lira donc exactement le monde sur lequel la phase C
      // revalidera. Aucune seconde lecture, aucun fichier, aucune session.
      const context = buildProposalContext(snapshot, request.target_controversy_id, submitted);
      const contextText = serializeProposalContext(context);

      // ---- Borne AVANT tout engagement. Le refus est antérieur au quota, à
      // l'`invocation_id`, au ledger et à l'adaptateur : il ne consomme rien,
      // n'écrit rien, et n'atteint aucun fournisseur. Ni troncature, ni résumé.
      const contextBytes = assertProposalContextWithinBound(contextText);
      const audit = auditProposalContext(context, contextText);

      // ---- `R0`. Capturée AVANT le dispatch, sous ce verrou. Elle ne sera
      // jamais remplacée par une valeur observée plus tard.
      const r0 = snapshot.reconciliation_revision;

      const binding = snapshot.manifest.experts[request.expert_slot];

      // ---- Quota AVANT engagement.
      await assertInvocationQuotaAvailable(paths, request.runId);

      // ---- Engagement durable, avec son déclencheur dédié. Version de schéma
      // dérivée de la charge par `invocationLedgerSchemaVersionFor`.
      const invocations = await (seams.openInvocationLedger ?? openInvocationLedger)(
        paths,
        request.runId,
      );
      const dispatch = await invocations.append(
        {
          identity: {
            generation: 'NATIVE_V21_EXECUTION',
            expert_slot: request.expert_slot,
            provider: binding.provider,
          },
          trigger_kind: RECONCILIATION_PROPOSAL_TRIGGER,
          // Audit du contexte — version, sources lues, taille, condensat. Le
          // prompt lui-même n'est pas journalisé : ces quatre faits suffisent à
          // rejouer la composition depuis les journaux canoniques.
          proposal_context_version: audit.context_version,
          context_source_ids: audit.context_source_ids,
          context_utf8_bytes: audit.context_utf8_bytes,
          context_sha256: audit.context_sha256,
        },
        deps.now(),
      );

      return {
        invocationId: dispatch.invocation_id,
        provider: binding.provider,
        cwd: snapshot.manifest.workspace.cwd,
        runtime:
          snapshot.manifest.runtime_config === undefined
            ? undefined
            : runtimeSettingsOf(snapshot.manifest.runtime_config),
        prompt: buildProposalPrompt(request.target_controversy_id, submitted, contextText),
        submitted,
        r0,
        contextBytes,
      };
    },
  );
}

interface ProposalPersistence {
  readonly kind: 'PERSISTED' | 'REFUSED';
  readonly entries?: readonly ReconciliationProposedEntry[];
  readonly revision?: string;
  readonly check?: ProposalRevalidationCheck;
  readonly detail?: string;
}

function refusedAt(check: ProposalRevalidationCheck, detail: string): ProposalPersistence {
  return { kind: 'REFUSED', check, detail };
}

/**
 * PHASE C — verrou NEUF, relecture, revalidation complète, lot unique.
 *
 * ```text
 * R1 est comparée à R0 — jamais l'inverse ; R0 n'est jamais remplacée avant.
 * ```
 *
 * Tout ce qui conditionne l'écriture et **peut avoir changé** est revalidé
 * contre l'instantané relu. Le quota et la politique d'usage ne le sont pas :
 * ce sont des préconditions d'**engagement**, et les revérifier après retour
 * annulerait un engagement déjà durable parce que la suite a coûté.
 *
 * ```text
 * TOUT-OU-RIEN : un seul refus laisse zéro proposition persistée.
 * ```
 */
async function persistProposals(
  deps: ReconciliationProposerDeps,
  input: {
    readonly runId: string;
    readonly targetControversyId: string;
    readonly invocationId: string;
    readonly submitted: readonly string[];
    readonly r0: string;
    readonly proposals: readonly ProposedReconciliation[];
  },
): Promise<ProposalPersistence> {
  const paths = runPaths(deps.runsDir, input.runId);

  return withNativeMutation(
    { runsDir: deps.runsDir, runId: input.runId, command: 'v5-propose-model-persist' },
    async () => {
      const snapshot = await readStableNativeRunSnapshot(deps.runsDir, input.runId);

      // ---- 4. La révision autoritaire relue — `R1`, comparée à `R0`.
      const r1 = snapshot.reconciliation_revision;
      if (r1 !== input.r0) {
        return refusedAt('R0', `référence ${input.r0} périmée ; état relu ${r1}.`);
      }

      const submitted = new Set(input.submitted);
      for (const [index, proposal] of input.proposals.entries()) {
        // ---- 1 · 2 · 3. Cible, existence et appartenance, par le propriétaire.
        try {
          validateDeclaredScope(snapshot, {
            target_controversy_id: input.targetControversyId,
            scope_kind: 'SUBSET',
            scope: proposal.scope,
          });
        } catch (error) {
          const reason = isCcrError(error)
            ? String((error.details as { reason?: string } | undefined)?.reason)
            : 'UNKNOWN';
          return refusedAt('SCOPE', `proposals[${String(index)}] : ${reason}.`);
        }

        // ---- 5. `EXISTE MAINTENANT ≠ A ÉTÉ SOUMIS`. Une unité apparue pendant
        // l'appel résout parfaitement, et n'a pourtant jamais été soumise.
        for (const unit of proposal.scope) {
          if (!submitted.has(unit)) {
            return refusedAt(
              'SUBMITTED_SET',
              `proposals[${String(index)}] : ${unit} n'appartient pas à l'ensemble soumis.`,
            );
          }
        }
      }

      // ---- 9. L'identité `rcn_` est allouée contre le journal autoritaire
      // relu, sous CE verrou, et jamais réservée pendant la latence.
      const journal = await readReconciliationJournal(paths);
      const recordedAt = deps.now().toISOString();
      const entries: ReconciliationProposedEntry[] = [];
      for (const [index, proposal] of input.proposals.entries()) {
        const candidate = {
          schema_version: RECONCILIATION_SCHEMA_VERSION,
          entry_id: formatReconciliationId(journal.next_sequence + index),
          kind: 'RECONCILIATION_PROPOSED',
          target: { kind: 'CONTROVERSY', controversy_id: input.targetControversyId },
          semantic_origin: 'CCR',
          recorded_by: 'CCR',
          recorded_at: recordedAt,
          // ---- 4. La révision de l'instantané RELU, jamais celle du dispatch.
          observed_revision: r1,
          // Une sélection dans un ensemble fourni reste un `SUBSET`, même si
          // elle couvre tout : `S4` en a fait la doctrine.
          scope_kind: 'SUBSET',
          scope: [...proposal.scope],
          derivation: {
            method: 'MODEL_ASSISTED',
            invocation_id: input.invocationId,
            // Les entrées de dérivation sont l'ensemble SOUMIS, jamais autre
            // chose : elles ne peuvent pas affirmer ce que le modèle n'a pas vu.
            inputs: [...input.submitted],
          },
          options: proposal.options.map(
            (option): ProposalOption => ({ option_id: option.option_id, content: option.content }),
          ),
        } as unknown as ReconciliationEntry;

        // ---- 7 · 8. La validation canonique déterministe, INTÉGRALEMENT.
        try {
          validateReconciliationEntry(candidate);
        } catch (error) {
          return refusedAt(
            'CANONICAL_FORM',
            `proposals[${String(index)}] : ${error instanceof Error ? error.message : 'invalide'}`,
          );
        }
        entries.push(candidate as ReconciliationProposedEntry);
      }

      // ---- 10. Un seul append, après toutes les validations.
      await appendReconciliationEntries(paths, entries);
      const written = await readReconciliationJournal(paths);
      return { kind: 'PERSISTED', entries, revision: written.revision };
    },
  );
}

/**
 * Exécute une demande de proposition assistée par modèle.
 *
 * ```text
 * PROVIDER_EFFECT   AT_MOST(1)
 * ```
 *
 * Un seul appel, jamais deux. Aucun échec — de fournisseur, d'analyse, de
 * revalidation ou de persistance — ne déclenche une seconde tentative, ni une
 * demande de correction au modèle, ni un repli sur un autre fournisseur, ni une
 * comparaison, ni un vote. Un nouveau geste humain crée une **nouvelle**
 * invocation, avec sa propre identité et son propre engagement.
 *
 * Le verrou n'est tenu ni pendant l'appel, ni pendant l'attente : la phase A le
 * relâche avant, la phase C en acquiert un neuf après (`C43`).
 */
export async function proposeReconciliationByModel(
  deps: ReconciliationProposerDeps,
  request: ReconciliationProposalRequest,
  seams: ReconciliationProposalSeams = {},
): Promise<ReconciliationProposalOutcome> {
  const paths = runPaths(deps.runsDir, request.runId);

  // ---- PHASE A.
  const plan = await planProposal(deps, request, seams);

  // ---- PHASE B. Hors verrou. Un seul appel, sans reprise ni second essai.
  await seams.beforeProvider?.();
  const adapters = deps.createAdapters(plan.cwd, plan.runtime);
  let turn: AgentTurnResult;
  try {
    turn = await adapters[plan.provider].start(plan.prompt);
  } catch (error) {
    // L'invocation reste un fait durable. Aucun usage n'est inventé, aucune
    // proposition n'est écrite, et aucune seconde tentative n'a lieu.
    //
    // L'issue est commitée AVANT d'être rendue. `UNEXPECTED` reste la valeur
    // publique du résultat — inchangée —, mais n'est pas persistée : côté
    // durable, un code inconnu s'omet plutôt que de se déguiser en cause.
    await commitInvocationOutcome(
      deps,
      request.runId,
      'v5-propose-model-outcome',
      plan.invocationId,
      isCcrError(error)
        ? { kind: 'V5_PROVIDER_FAILED', error_code: error.code }
        : { kind: 'V5_PROVIDER_FAILED' },
    );
    return {
      kind: 'PROVIDER_FAILED',
      invocation_id: plan.invocationId,
      error_code: isCcrError(error) ? error.code : 'UNEXPECTED',
    };
  }

  // ---- Usage observé, sous son propre verrou court — acquisition distincte,
  // le verrou n'étant pas réentrant.
  await withNativeMutation(
    { runsDir: deps.runsDir, runId: request.runId, command: 'v5-propose-model-usage' },
    async () => {
      const recorder = createUsageRecorder(
        await (seams.openUsageLedger ?? openUsageLedger)(paths, request.runId),
        plan.invocationId,
        deps.now,
      );
      await recordTurnUsage(recorder, turn);
    },
  );

  // ---- ANALYSE. La section 1/3 fait autorité, et elle est la seule.
  const parsed = parseReconciliationProposals(turn.content, request.target_controversy_id);
  if (parsed.outcome === 'INVALID') {
    // Le vocabulaire de motif V5 est conservé tel quel : ni traduit, ni fusionné
    // avec ceux de V3 et V4, qui comptent d'autres valeurs.
    await commitInvocationOutcome(deps, request.runId, 'v5-propose-model-outcome', plan.invocationId, {
      kind: 'V5_INVALID_OUTPUT',
      reason: parsed.reason,
      at: parsed.at,
    });
    return {
      kind: 'INVALID_OUTPUT',
      invocation_id: plan.invocationId,
      reason: parsed.reason,
      at: parsed.at,
    };
  }
  if (parsed.proposals.length === 0) {
    // Succès opérationnel du chemin modèle. Ne signifie ni « rien à réconcilier »,
    // ni accord, ni absence de désaccord, ni absence de matière.
    //
    // Aucune proposition n'est écrite : sans fait durable, cette issue serait
    // après redémarrage indiscernable d'une tentative interrompue. Elle est
    // commitée AVANT d'être rendue, sous une acquisition courte distincte.
    await commitInvocationOutcome(
      deps,
      request.runId,
      'v5-propose-model-outcome',
      plan.invocationId,
      { kind: 'VALID_ZERO' },
    );
    return { kind: 'VALID_ZERO', invocation_id: plan.invocationId };
  }

  // ---- PHASE C.
  const persisted = await persistProposals(deps, {
    runId: request.runId,
    targetControversyId: request.target_controversy_id,
    invocationId: plan.invocationId,
    submitted: plan.submitted,
    r0: plan.r0,
    proposals: parsed.proposals,
  });

  if (persisted.kind === 'REFUSED') {
    await commitInvocationOutcome(deps, request.runId, 'v5-propose-model-outcome', plan.invocationId, {
      kind: 'V5_REVALIDATION_REFUSED',
      check: persisted.check as ProposalRevalidationCheck,
      detail: persisted.detail as string,
    });
    return {
      kind: 'REVALIDATION_REFUSED',
      invocation_id: plan.invocationId,
      check: persisted.check as ProposalRevalidationCheck,
      detail: persisted.detail as string,
    };
  }

  return {
    kind: 'RECORDED',
    invocation_id: plan.invocationId,
    entries: persisted.entries as readonly ReconciliationProposedEntry[],
    reconciliation_revision: persisted.revision as string,
  };
}

// ==========================================================================
// SECTION 3/3 — Frontière de disponibilité publique
// ==========================================================================

/**
 * Trois faits **indépendants**, qu'aucun raisonnement ne doit fusionner.
 *
 * ```text
 * IMPLEMENTED             la capacité technique existe (2/3)
 * RUNTIME_AVAILABILITY    ce qu'un humain est autorisé à demander
 * validation RÉELLE       NOT_TESTED tant que G4 n'a pas eu lieu
 * ```
 *
 * « Implémenté » n'implique pas « disponible ». « Éprouvé avec un adaptateur
 * doublé » n'implique pas « validé en réel ».
 */
export const MODEL_RECONCILIATION_PROPOSAL_IMPLEMENTED = true;

export type ReconciliationProposalAvailability = 'NOT_AVAILABLE' | 'AVAILABLE';

/**
 * Disponibilité **publique** — `AVAILABLE` depuis la décision produit du
 * 2026-08-21, `NOT_AVAILABLE` de `S13` à `G5`.
 *
 * Ce n'est pas un diagnostic. Elle n'affirme ni qu'un fournisseur répond, ni
 * qu'un quota reste, ni qu'un adaptateur est configuré, ni qu'une controverse
 * mérite une proposition. Elle dit une seule chose — **ce qu'un humain est
 * autorisé à déclencher à cet instant**.
 *
 * Elle est **service-autoritaire** : aucune variable d'environnement, aucun
 * fichier de validation, aucun drapeau mutable, aucun état runtime ne la
 * calcule. Qu'un adaptateur doublé traverse tout le pipeline dans les tests ne
 * la change pas d'un iota.
 *
 * **Levée — décision produit humaine du 2026-08-21.** La porte est ouverte par
 * une décision d'autorité humaine, et par elle seule. Le micro-gate `G4` avait
 * rendu `KEEP` : son unique appel réel a été refusé par le parseur strict, sans
 * append canonique. Ce verdict reste un fait historique, et cette levée ne
 * prétend pas qu'il ait réussi. L'humain a décidé d'ouvrir le chemin normal
 * pour qualifier la fonction en conditions réelles — la qualification vient
 * après l'ouverture, elle ne la précède pas.
 *
 * `AVAILABLE` dit une seule chose : le produit **peut demander** une proposition
 * assistée par le chemin normal. Elle ne dit jamais que le modèle décide,
 * clôture, arbitre, que la proposition devient vraie, ni qu'elle reçoit une
 * autorité humaine. Tout ce qui protégeait cette distinction demeure —
 * engagement durable avant l'appel, parseur strict, `R0`/`R1`, journalisation,
 * absence de reprise implicite, et `PROPOSITION ≠ DÉCISION`.
 */
export const MODEL_RECONCILIATION_PROPOSAL_RUNTIME_AVAILABILITY: ReconciliationProposalAvailability =
  'AVAILABLE';

/**
 * Les six issues de domaine du chemin assisté — §38.4, mot pour mot.
 *
 * Cinq viennent de la section 2/3 et traversent la porte **sans réécriture** ;
 * la sixième appartient à la porte elle-même. Aucune septième n'existe : ni
 * `PARTIAL`, ni `RETRYING`, ni `RECOVERING`, ni un statut d'incertitude après
 * engagement — celui-ci se **lit** dans le ledger et l'usage.
 */
export const MODEL_RECONCILIATION_PROPOSAL_DOMAIN_OUTCOMES = [
  'RECORDED',
  'VALID_ZERO',
  'NOT_AVAILABLE',
  'INVALID_OUTPUT',
  'REVALIDATION_REFUSED',
  'PROVIDER_FAILED',
] as const;

/**
 * Issue d'une demande **publique** — union discriminée.
 *
 * L'imbrication est délibérée : un appelant ne peut pas lire `proposal` sans
 * avoir d'abord constaté `DISPATCHED`, si bien qu'un refus de disponibilité ne
 * peut pas être confondu avec une issue du pipeline.
 */
export type PublicReconciliationProposalOutcome =
  | {
      readonly kind: 'NOT_AVAILABLE';
      readonly availability: ReconciliationProposalAvailability;
    }
  | { readonly kind: 'DISPATCHED'; readonly proposal: ReconciliationProposalOutcome };

/**
 * Demande **publique** de proposition assistée.
 *
 * La porte est franchie **avant** toute gouvernance. Un refus :
 *
 * ```text
 * ne lit aucun run          n'alloue aucune identité
 * ne consomme aucun quota   n'engage aucune invocation
 * n'appelle aucun adaptateur   n'écrit aucun octet
 * ```
 *
 * Une porte fermée ne coûte rien — et c'est ce qui la rend vérifiable.
 *
 * L'appelant ne choisit jamais la politique de disponibilité : il n'existe ni
 * option, ni drapeau, ni champ de requête qui permette de la contourner. La voie
 * d'acceptation est une **fonction distincte**, pas un paramètre de celle-ci.
 */
export async function requestModelReconciliationProposal(
  deps: ReconciliationProposerDeps,
  request: ReconciliationProposalRequest,
  seams: ReconciliationProposalSeams = {},
): Promise<PublicReconciliationProposalOutcome> {
  if (MODEL_RECONCILIATION_PROPOSAL_RUNTIME_AVAILABILITY !== 'AVAILABLE') {
    return {
      kind: 'NOT_AVAILABLE',
      availability: MODEL_RECONCILIATION_PROPOSAL_RUNTIME_AVAILABILITY,
    };
  }
  return {
    kind: 'DISPATCHED',
    proposal: await proposeReconciliationByModel(deps, request, seams),
  };
}

/**
 * Autorisation de la voie d'acceptation contrôlée, réservée au micro-gate `G4`.
 *
 * Elle n'est **pas** un paramètre que l'on demande : aucune surface publique n'en
 * construit, et rien de ce qui vient d'une requête, des données d'un run, du
 * contenu d'une controverse ou de la sortie d'un fournisseur ne peut en produire
 * une. Sa seule origine est un appel interne écrit à la main pour ce gate.
 */
export interface ReconciliationProposalAcceptanceAuthorization {
  readonly gate: 'G4_REAL_PROPOSAL_ACCEPTANCE';
  readonly humanAuthorization: string;
}

/**
 * Voie d'acceptation contrôlée — ce qu'elle franchit, et ce qu'elle ne franchit
 * pas.
 *
 * ```text
 * FRANCHIT      la porte d'EXPOSITION PUBLIQUE, et elle seule — parce qu'elle
 *               EST le mécanisme qui décidera qu'on peut la lever
 *
 * NE FRANCHIT   quota · InvocationLedger · DISPATCH_COMMITTED · adaptateur
 * PAS           parseur strict · R0/R1 · ensemble soumis · revalidation
 *               tout-ou-rien du lot · discipline de verrou · persistance
 * ```
 *
 * Elle ne lit ni n'écrit la disponibilité : sa levée sera un changement de code
 * adossé à son verdict, jamais un effet de bord de son exécution.
 */
export async function runControlledAcceptanceProposal(
  deps: ReconciliationProposerDeps,
  request: ReconciliationProposalRequest,
  authorization: ReconciliationProposalAcceptanceAuthorization,
  seams: ReconciliationProposalSeams = {},
): Promise<ReconciliationProposalOutcome> {
  if (authorization.gate !== 'G4_REAL_PROPOSAL_ACCEPTANCE') {
    throw new CcrError('INVALID_ARGUMENT', "La voie d'acceptation exige son autorisation de gate.", {
      details: { reason: 'ACCEPTANCE_AUTHORIZATION_REQUIRED' },
    });
  }
  if (
    typeof authorization.humanAuthorization !== 'string' ||
    authorization.humanAuthorization.length === 0
  ) {
    throw new CcrError(
      'INVALID_ARGUMENT',
      "La voie d'acceptation exige une autorisation humaine énoncée.",
      { details: { reason: 'ACCEPTANCE_AUTHORIZATION_REQUIRED' } },
    );
  }
  return proposeReconciliationByModel(deps, request, seams);
}
