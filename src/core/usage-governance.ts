/**
 * Contrats **persistés** de la gouvernance d'usage (CCR V2.2, V0.1 · IMP-01).
 *
 * Deux journaux additifs, et leurs invariants :
 *
 * ```text
 * invocations.jsonl   ce que CCR s'est durablement engagé à tenter
 * usage.jsonl         ce qui a été observé autour de ces tentatives
 * ```
 *
 * Module pur : aucune lecture, aucune écriture, aucune connaissance des
 * chemins. Il décrit ce qu'un enregistrement doit être, et refuse le reste.
 *
 * ## Une seule écriture de chaque fait
 *
 * `generation` et `provider` vivent **dans** `identity`, et nulle part
 * ailleurs. La spécification V0.1 §6 les listait aussi à la racine ; les
 * dupliquer créerait deux champs capables de diverger pour un fait unique —
 * exactement ce que la doctrine interdit depuis le journal natif. Resserrement
 * consigné en `V2.2-IMP-01`.
 *
 * ## Ce que ce module ne fait pas
 *
 * Aucun coût dérivé, aucun tarif, aucun quota, aucun total de jetons. Aucun
 * contenu non plus : un journal d'usage n'est pas un second transcript, et la
 * validation refuse activement les champs qui le rendraient tel.
 */

import { CcrError } from './errors.ts';
import { isExpertSlotId, isProviderKind } from './expert.ts';
import type { ExpertSlotId, ProviderKind } from './expert.ts';
import type { AgentKind } from './run.ts';
import type { RunExecutionMode } from './run-native.ts';
import { USAGE_PROVENANCES } from './usage.ts';
import type {
  ProviderDetails,
  ProviderReportedCost,
  ProviderTimings,
  UsageModel,
  UsageProvenance,
  UsageTokens,
} from './usage.ts';

// --------------------------------------------------------------------------
// Versions
// --------------------------------------------------------------------------

/**
 * Version du schéma **historique** du journal d'invocations.
 *
 * Elle reste à 1, et c'est une décision, pas un oubli. La bumper ferait écrire
 * en version 2 **toutes** les nouvelles invocations — `START`, `STEP`, `SEND`,
 * `RECOVERY_CONTINUE` — sur une installation qui n'emploiera jamais la
 * détection de controverse. Ses journaux deviendraient illisibles par le
 * runtime V2.2 sans qu'aucune détection n'ait eu lieu : une régression pure.
 */
export const INVOCATION_LEDGER_SCHEMA_VERSION = 1;

/**
 * Version introduite par V3.
 *
 * Elle n'ajoute aucun champ : elle élargit le **vocabulaire de déclencheurs**.
 * Un enregistrement ne la porte que parce que sa charge n'est pas représentable
 * en version 1 — jamais parce que le runtime est V3.
 */
export const INVOCATION_LEDGER_SCHEMA_VERSION_V2 = 2;

/**
 * Version introduite par V4.
 *
 * Même raison, une version plus loin : elle n'ajoute aucun champ et élargit le
 * seul vocabulaire de déclencheurs. Ajouter `EVIDENCE_ADDUCTION` à la version 2
 * aurait été un défaut réel — un lecteur de l'ère V3 aurait vu une version qu'il
 * admet porter une valeur qu'il refuse, et aurait rejeté le **journal entier**
 * plutôt que la seule ligne inconnue. Une version propre le laisse refuser
 * exactement ce qu'il ne connaît pas, ligne par ligne.
 */
export const INVOCATION_LEDGER_SCHEMA_VERSION_V3 = 3;

/**
 * Version introduite par V5.
 *
 * Même raison, une version plus loin : aucun champ nouveau, un seul vocabulaire
 * élargi. `RECONCILIATION_PROPOSAL` n'est **pas** ajouté à la version 3 — un
 * lecteur de l'ère V4 verrait une version qu'il admet porter une valeur qu'il
 * refuse, et rejetterait le journal entier plutôt que la seule ligne inconnue.
 *
 * ```text
 * NO RETROACTIVE VOCABULARY REWRITE
 * ```
 */
export const INVOCATION_LEDGER_SCHEMA_VERSION_V4 = 4;

/**
 * Versions que ce runtime sait lire.
 *
 * ```text
 * LA VERSION QUALIFIE L'ENREGISTREMENT, PAS LE FICHIER
 * ```
 *
 * Un journal n'a pas d'époque. La séquence `v1 · v2 · v3 · v1` est légitime, et
 * chaque ligne est analysée selon **sa** version. Aucune migration n'existe :
 * la compatibilité est assurée par le lecteur, jamais par une réécriture.
 */
export const SUPPORTED_INVOCATION_LEDGER_SCHEMA_VERSIONS: readonly number[] = [
  INVOCATION_LEDGER_SCHEMA_VERSION,
  INVOCATION_LEDGER_SCHEMA_VERSION_V2,
  INVOCATION_LEDGER_SCHEMA_VERSION_V3,
  INVOCATION_LEDGER_SCHEMA_VERSION_V4,
];

export const USAGE_LEDGER_SCHEMA_VERSION = 1;

// --------------------------------------------------------------------------
// Identifiants
// --------------------------------------------------------------------------

const INVOCATION_ID_PATTERN = /^inv_(\d{6,})$/;
const USAGE_OBSERVATION_ID_PATTERN = /^usage_(\d{6,})$/;

/** Même convention que `evt_NNNNNN` : lisible, triable, séquentielle par run. */
export function formatInvocationId(sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new CcrError('INVALID_ARGUMENT', `Séquence d'invocation invalide : ${String(sequence)}`);
  }
  return `inv_${String(sequence).padStart(6, '0')}`;
}

export function parseInvocationSequence(id: string): number | undefined {
  const digits = INVOCATION_ID_PATTERN.exec(id)?.[1];
  return digits === undefined ? undefined : Number.parseInt(digits, 10);
}

export function formatUsageObservationId(sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new CcrError('INVALID_ARGUMENT', `Séquence d'observation invalide : ${String(sequence)}`);
  }
  return `usage_${String(sequence).padStart(6, '0')}`;
}

export function parseUsageObservationSequence(id: string): number | undefined {
  const digits = USAGE_OBSERVATION_ID_PATTERN.exec(id)?.[1];
  return digits === undefined ? undefined : Number.parseInt(digits, 10);
}

// --------------------------------------------------------------------------
// InvocationLedger
// --------------------------------------------------------------------------

/**
 * Déclencheurs **réellement** producteurs de modèle.
 *
 * `HANDOFF` en est absent : il ouvre un terminal humain, dont CCR ne mesure
 * rien et ne prétend rien. `PAUSE`, `RESUME` et les acquittements de reprise
 * n'appellent aucun fournisseur.
 */
/**
 * Vocabulaire de la version 1 — **figé pour toujours**.
 *
 * Ce n'est pas une copie de la liste ci-dessous : c'est le vocabulaire exact
 * qu'un enregistrement v1 peut porter, et il ne bougera plus. Un lecteur V2.2
 * connaît celui-ci et rien d'autre ; l'élargir rétroactivement reviendrait à
 * réécrire ce que V2.2 savait.
 */
export const INVOCATION_TRIGGER_KINDS_V1 = ['START', 'STEP', 'SEND', 'RECOVERY_CONTINUE'] as const;

/**
 * Déclencheur propre à la détection de controverse V3.
 *
 * Il dit **pourquoi** une invocation a été engagée, jamais ce qu'elle a trouvé.
 * Aucune lecture ne peut en déduire qu'une controverse existe, qu'un désaccord
 * a été détecté, qu'une sortie de modèle était exploitable, ni qu'un
 * fournisseur a facturé quoi que ce soit.
 *
 * Aucun déclencheur existant n'est réutilisé pour cela : `SEND` ou `STEP`
 * porteraient un faux sens, et un journal qui ment sur la raison d'un appel ne
 * vaut rien comme autorité.
 */
export const CONTROVERSY_DETECTION_TRIGGER = 'CONTROVERSY_DETECTION';

/**
 * Déclencheur propre à l'adduction probatoire assistée par modèle, en V4.
 *
 * Il dit **pourquoi** une invocation a été engagée, jamais ce qu'elle a produit.
 * Aucune lecture ne peut en déduire qu'une adduction a été persistée, qu'une
 * orientation a été proposée, qu'une sortie était exploitable, ni qu'un
 * fournisseur a facturé quoi que ce soit.
 *
 * ```text
 * EVIDENCE_ADDUCTION   ≠   adduction persistée
 * ```
 *
 * Un engagement peut parfaitement exister sans qu'aucune adduction ne suive.
 *
 * Aucun déclencheur existant n'est réutilisé : `CONTROVERSY_DETECTION`
 * porterait un faux sens — une demande d'adduction n'est pas une détection de
 * controverse —, et un journal qui ment sur la raison d'un appel ne vaut rien
 * comme autorité.
 */
export const EVIDENCE_ADDUCTION_TRIGGER = 'EVIDENCE_ADDUCTION';

/**
 * Déclencheur propre à la proposition de réconciliation assistée par modèle, en
 * V5.
 *
 * Il dit **pourquoi** une invocation a été engagée, jamais ce qu'elle a produit.
 * Aucune lecture ne peut en déduire qu'une proposition a été enregistrée, qu'une
 * option est recommandable, qu'une sortie était exploitable, qu'une décision a
 * été prise, ni qu'un fournisseur a facturé quoi que ce soit.
 *
 * ```text
 * RECONCILIATION_PROPOSAL   ≠   proposition enregistrée
 * RECONCILIATION_PROPOSAL   ≠   décision · clôture · supersession
 * ```
 *
 * Aucun déclencheur existant n'est réutilisé : `EVIDENCE_ADDUCTION` dirait une
 * adduction probatoire, `CONTROVERSY_DETECTION` une détection de controverse, et
 * les quatre valeurs de la version 1 un tour d'exécution. Un journal qui ment
 * sur la raison d'un appel ne vaut rien comme autorité.
 *
 * ```text
 * AUDIT LABEL  ≠  PLACEHOLDER
 * ```
 */
export const RECONCILIATION_PROPOSAL_TRIGGER = 'RECONCILIATION_PROPOSAL';

/**
 * Déclencheurs **réellement** producteurs de modèle.
 *
 * `HANDOFF` en est absent : il ouvre un terminal humain, dont CCR ne mesure
 * rien et ne prétend rien. `PAUSE`, `RESUME` et les acquittements de reprise
 * n'appellent aucun fournisseur.
 *
 * L'union reste **fermée et typée** : une valeur inconnue est refusée, et il
 * n'existe aucun repli `OTHER`, `CUSTOM` ni `UNKNOWN`.
 */
export const INVOCATION_TRIGGER_KINDS = [
  'START',
  'STEP',
  'SEND',
  'RECOVERY_CONTINUE',
  'CONTROVERSY_DETECTION',
  'EVIDENCE_ADDUCTION',
  'RECONCILIATION_PROPOSAL',
] as const;
export type InvocationTriggerKind = (typeof INVOCATION_TRIGGER_KINDS)[number];

/**
 * Vocabulaire admis par la version 2 — v1 **plus** la détection de controverse.
 *
 * Énoncé une fois, pour que le vocabulaire d'une version soit une liste et non
 * le résultat d'une soustraction : la version 2 ne se définit pas comme
 * « tout sauf V4 », qui deviendrait faux à chaque version suivante.
 */
export const INVOCATION_TRIGGER_KINDS_V2 = [
  ...INVOCATION_TRIGGER_KINDS_V1,
  CONTROVERSY_DETECTION_TRIGGER,
] as const satisfies readonly InvocationTriggerKind[];

/**
 * Vocabulaire admis par la version 3 — v2 **plus** l'adduction probatoire.
 *
 * Énoncé explicitement à partir de V5, pour la même raison que le précédent :
 * tant que la version 3 était la dernière, `INVOCATION_TRIGGER_KINDS` la
 * décrivait par coïncidence. Elle a cessé de la décrire dès qu'une version de
 * plus a existé, et une liste figée est le seul moyen qu'un vocabulaire
 * historique ne s'élargisse pas dans le dos de ses lecteurs.
 *
 * ```text
 * v3 NE CONNAÎT PAS RECONCILIATION_PROPOSAL
 * ```
 */
export const INVOCATION_TRIGGER_KINDS_V3 = [
  ...INVOCATION_TRIGGER_KINDS_V2,
  EVIDENCE_ADDUCTION_TRIGGER,
] as const satisfies readonly InvocationTriggerKind[];

/**
 * Vocabulaire admis par une version donnée — **une branche par version**.
 *
 * Chaque version est strictement additive : elle admet tout ce que la
 * précédente admet, et une valeur de plus. L'inverse serait incohérent — une
 * version plus récente ne rétrécit pas un champ qu'elle élargit.
 *
 * La forme est délibérément exhaustive plutôt que « v1, sinon le dernier
 * vocabulaire ». Ce repli faisait admettre à la version 2 tout déclencheur
 * futur : le jour où V4 en ajoute un, un enregistrement v2 l'aurait accepté, et
 * un lecteur de l'ère V3 aurait rejeté le journal entier sur une valeur
 * d'énumération. Une version inconnue ne reçoit donc **aucun** vocabulaire.
 */
export function invocationTriggerKindsFor(version: number): readonly InvocationTriggerKind[] {
  switch (version) {
    case INVOCATION_LEDGER_SCHEMA_VERSION:
      return INVOCATION_TRIGGER_KINDS_V1;
    case INVOCATION_LEDGER_SCHEMA_VERSION_V2:
      return INVOCATION_TRIGGER_KINDS_V2;
    case INVOCATION_LEDGER_SCHEMA_VERSION_V3:
      return INVOCATION_TRIGGER_KINDS_V3;
    case INVOCATION_LEDGER_SCHEMA_VERSION_V4:
      return INVOCATION_TRIGGER_KINDS;
    default:
      return [];
  }
}

/**
 * Version de schéma qu'un enregistrement doit porter, **d'après son
 * déclencheur**.
 *
 * La version suit la charge, jamais le millésime du runtime : un `SEND` écrit
 * après une adduction reste en version 1, et une détection de controverse reste
 * en version 2. Aucun writer ne « monte » un enregistrement.
 *
 * Exhaustive, elle aussi. Un déclencheur non listé retombe sur la **version
 * 1** — jamais sur la dernière. Ce n'est pas un repli commode : c'est le choix
 * qui garantit qu'une valeur inconnue soit **refusée** plutôt qu'admise. La
 * version 1 porte le vocabulaire le plus étroit, donc le validateur d'écriture
 * la rejettera, avec le même code qu'avant V4. Retomber sur la dernière
 * version ferait l'inverse : elle admet le plus, et accueillerait en silence ce
 * que personne n'a déclaré.
 */
export function invocationLedgerSchemaVersionFor(trigger: InvocationTriggerKind): number {
  if ((INVOCATION_TRIGGER_KINDS_V1 as readonly string[]).includes(trigger)) {
    return INVOCATION_LEDGER_SCHEMA_VERSION;
  }
  if (trigger === CONTROVERSY_DETECTION_TRIGGER) return INVOCATION_LEDGER_SCHEMA_VERSION_V2;
  if (trigger === EVIDENCE_ADDUCTION_TRIGGER) return INVOCATION_LEDGER_SCHEMA_VERSION_V3;
  if (trigger === RECONCILIATION_PROPOSAL_TRIGGER) return INVOCATION_LEDGER_SCHEMA_VERSION_V4;
  return INVOCATION_LEDGER_SCHEMA_VERSION;
}

/**
 * Identité d'une invocation — **union discriminée par génération**.
 *
 * Un run natif nomme un rôle ; un run historique nomme un moteur. Aucun
 * `expert_slot` n'est fabriqué pour le second, et le `provider` n'est jamais
 * l'identité opérationnelle du premier : deux experts peuvent partager un
 * moteur, et c'est le cas que V2.1 existe pour rendre lisible.
 */
export type InvocationIdentity =
  | {
      readonly generation: 'NATIVE_V21_EXECUTION';
      readonly expert_slot: ExpertSlotId;
      readonly provider: ProviderKind;
    }
  | {
      readonly generation: 'LEGACY_V2_EXECUTION';
      readonly agent_kind: AgentKind;
      readonly provider: ProviderKind;
    };

/**
 * Engagement durable de CCR à tenter une production de modèle.
 *
 * Seul enregistrement du slice : le cycle de vie complet — issue, incertitude,
 * acquittement — appartient au câblage, et n'est pas anticipé ici.
 */
export interface InvocationDispatchRecord {
  readonly schema_version: number;
  readonly kind: 'DISPATCH_COMMITTED';
  readonly invocation_id: string;
  readonly run_id: string;
  readonly identity: InvocationIdentity;
  readonly trigger_kind: InvocationTriggerKind;
  /** Absent tant qu'aucune session native n'existe — c'est le cas de START. */
  readonly session_id?: string;
  /** Présent pour un transfert ; absent d'un envoi humain. */
  readonly round?: number;
  readonly prompt_event_id?: string;
  readonly source_event_id?: string;
  /** Présent uniquement si l'origine HTTP en fournit un. Une invocation CLI n'en a pas. */
  readonly operation_id?: string;
  /**
   * Audit du contexte sémantique transmis (`V5.1`, addendum du 2026-08-21).
   *
   * Quatre champs **facultatifs et additifs** : une invocation qui ne compose
   * aucun contexte n'en porte aucun, et les enregistrements antérieurs restent
   * lisibles sous leur version inchangée. Aucune version fermée n'est réécrite.
   *
   * Ils disent **ce qui a été lu**. `derivation.inputs`, sur l'enregistrement
   * V5, dit ce qui a été **soumis**. Les deux ne se déduisent pas l'un de
   * l'autre, et rien ici ne les fusionne.
   *
   * Le prompt lui-même n'est pas journalisé : sources, taille et condensat
   * suffisent à rejouer la composition depuis les journaux canoniques.
   */
  readonly proposal_context_version?: number;
  readonly context_source_ids?: readonly string[];
  readonly context_utf8_bytes?: number;
  readonly context_sha256?: string;
  readonly dispatch_committed_at: string;
}

/** Ce qu'un appelant fournit ; le store attribue identité et horodatage. */
export type NewInvocationDispatch = Omit<
  InvocationDispatchRecord,
  'schema_version' | 'kind' | 'invocation_id' | 'run_id' | 'dispatch_committed_at'
> & { readonly dispatch_committed_at?: string };

// --------------------------------------------------------------------------
// UsageLedger
// --------------------------------------------------------------------------

export const USAGE_OUTCOMES = ['RESPONSE_RECEIVED', 'FAILED', 'OUTCOME_UNCERTAIN'] as const;
export type UsageOutcome = (typeof USAGE_OUTCOMES)[number];

export const USAGE_FAILURE_STAGES = ['BEFORE_PROCESS', 'DURING_PROCESS', 'AFTER_PROCESS'] as const;
export type UsageFailureStage = (typeof USAGE_FAILURE_STAGES)[number];

/**
 * Une observation, rattachée à une invocation.
 *
 * Une invocation peut en porter zéro, une ou plusieurs. Zéro signifie
 * `UNKNOWN` — jamais zéro jeton, jamais zéro coût.
 */
export interface UsageObservationRecord {
  readonly schema_version: number;
  readonly usage_observation_id: string;
  readonly invocation_id: string;
  readonly run_id: string;
  readonly observed_at: string;
  readonly provenance: UsageProvenance;
  readonly outcome?: UsageOutcome;
  readonly tokens?: UsageTokens;
  readonly model?: UsageModel;
  readonly provider_reported_cost?: ProviderReportedCost;
  readonly provider_timings?: ProviderTimings;
  readonly provider_details?: ProviderDetails;
  readonly ccr_elapsed_ms?: number;
  readonly exit_code?: number | null;
  readonly error_code?: string;
  readonly failure_stage?: UsageFailureStage;
}

export type NewUsageObservation = Omit<
  UsageObservationRecord,
  'schema_version' | 'usage_observation_id' | 'run_id' | 'observed_at'
> & { readonly observed_at?: string };

/**
 * Champs qu'un journal d'usage ne portera jamais.
 *
 * La frontière est vérifiée à l'écriture **et** à la relecture : un ledger de
 * gouvernance qui accueillerait un prompt ou une réponse deviendrait un second
 * transcript, avec sa propre rétention et ses propres risques, pour un bénéfice
 * nul — la controverse est déjà canonique dans `events.jsonl`.
 */
export const USAGE_FORBIDDEN_FIELDS = [
  'prompt',
  'content',
  'response',
  'result',
  'message',
  'stdout',
  'stderr',
  'stdoutRaw',
  'stderrRaw',
] as const;

// --------------------------------------------------------------------------
// Validation
// --------------------------------------------------------------------------

function invalid(file: string, lineNumber: number | null, message: string, details: Record<string, unknown> = {}): CcrError {
  const where = lineNumber === null ? file : `${file} ligne ${String(lineNumber)}`;
  return new CcrError('JOURNAL_INVALID', `${where} : ${message}`, {
    details: { ...details, ...(lineNumber === null ? {} : { line: lineNumber }) },
  });
}

function asRecord(value: unknown, file: string, lineNumber: number | null): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(file, lineNumber, 'objet JSON attendu.');
  }
  return value as Record<string, unknown>;
}

function requireString(
  record: Record<string, unknown>,
  field: string,
  file: string,
  lineNumber: number | null,
): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw invalid(file, lineNumber, `${field} absent ou invalide.`, { field });
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  field: string,
  file: string,
  lineNumber: number | null,
): string | undefined {
  if (!(field in record) || record[field] === undefined) return undefined;
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw invalid(file, lineNumber, `${field} invalide.`, { field });
  }
  return value;
}

/**
 * Valide l'identité d'une invocation.
 *
 * Les champs étrangers à la branche sont **refusés**, jamais ignorés : un
 * `expert_slot` sur un run historique n'est pas une donnée en trop, c'est une
 * identité inventée. Et l'ignorer laisserait un fait non interprété dans un
 * fichier que l'on présente comme autoritaire.
 */
export function validateInvocationIdentity(
  value: unknown,
  file = 'invocations.jsonl',
  lineNumber: number | null = null,
): InvocationIdentity {
  const record = asRecord(value, file, lineNumber);
  const generation = record['generation'];
  const provider = record['provider'];

  if (!isProviderKind(provider)) {
    throw invalid(file, lineNumber, `provider inconnu (${String(provider)}).`, { field: 'provider' });
  }

  if (generation === 'NATIVE_V21_EXECUTION') {
    if ('agent_kind' in record) {
      throw invalid(file, lineNumber, "« agent_kind » n'a pas de sens sur un run natif : l'identité est un rôle.", {
        field: 'agent_kind',
      });
    }
    const slot = record['expert_slot'];
    if (!isExpertSlotId(slot)) {
      throw invalid(file, lineNumber, `expert_slot invalide (${String(slot)}).`, { field: 'expert_slot' });
    }
    return { generation, expert_slot: slot, provider };
  }

  if (generation === 'LEGACY_V2_EXECUTION') {
    if ('expert_slot' in record) {
      throw invalid(
        file,
        lineNumber,
        "« expert_slot » n'a pas de sens sur un run historique : ce modèle n'a pas de rôles.",
        { field: 'expert_slot' },
      );
    }
    const agent = record['agent_kind'];
    if (agent !== 'claude' && agent !== 'codex') {
      throw invalid(file, lineNumber, `agent_kind invalide (${String(agent)}).`, { field: 'agent_kind' });
    }
    return { generation, agent_kind: agent, provider };
  }

  throw invalid(file, lineNumber, `génération inconnue (${String(generation)}).`, { field: 'generation' });
}

export function validateInvocationDispatchRecord(
  value: unknown,
  lineNumber: number | null = null,
): InvocationDispatchRecord {
  const file = 'invocations.jsonl';
  const record = asRecord(value, file, lineNumber);

  // La version est lue sur CETTE ligne, et gouverne l'analyse de CETTE ligne.
  // Aucune époque de fichier n'existe, et une version inconnue est un refus —
  // jamais une ligne sautée, jamais une lecture partielle présentée comme
  // complète.
  const schemaVersion = record['schema_version'];
  if (typeof schemaVersion !== 'number' || !SUPPORTED_INVOCATION_LEDGER_SCHEMA_VERSIONS.includes(schemaVersion)) {
    throw invalid(file, lineNumber, `schema_version non pris en charge (${String(schemaVersion)}).`, {
      field: 'schema_version',
    });
  }
  if (record['kind'] !== 'DISPATCH_COMMITTED') {
    throw invalid(file, lineNumber, `kind inconnu (${String(record['kind'])}).`, { field: 'kind' });
  }

  const invocationId = requireString(record, 'invocation_id', file, lineNumber);
  if (parseInvocationSequence(invocationId) === undefined) {
    throw invalid(file, lineNumber, `invocation_id non canonique (${invocationId}).`, { field: 'invocation_id' });
  }

  // Vocabulaire **de la version portée par la ligne**. Un enregistrement v1 ne
  // peut donc pas porter le déclencheur de détection : l'y admettre ferait
  // échouer un lecteur V2.2 sur une valeur d'énumération plutôt que sur une
  // version, ce que le contrat refuse explicitement — un refus lisible vaut
  // mieux qu'une erreur d'analyse.
  const allowedTriggers = invocationTriggerKindsFor(schemaVersion);
  const trigger = record['trigger_kind'];
  if (typeof trigger !== 'string' || !(allowedTriggers as readonly string[]).includes(trigger)) {
    throw invalid(
      file,
      lineNumber,
      `trigger_kind inconnu pour la version ${String(schemaVersion)} (${String(trigger)}).`,
      { field: 'trigger_kind', schema_version: schemaVersion },
    );
  }

  const round = record['round'];
  if (round !== undefined && (typeof round !== 'number' || !Number.isInteger(round) || round < 0)) {
    throw invalid(file, lineNumber, 'round invalide.', { field: 'round' });
  }

  // ---- Audit du contexte (`V5.1`). Facultatif, mais présent implique valide :
  // un audit à moitié écrit décrirait un contexte que personne ne pourrait
  // reconstruire, et vaudrait moins qu'aucun audit.
  const contextVersion = record['proposal_context_version'];
  if (
    contextVersion !== undefined &&
    (typeof contextVersion !== 'number' || !Number.isInteger(contextVersion) || contextVersion < 1)
  ) {
    throw invalid(file, lineNumber, 'proposal_context_version invalide.', {
      field: 'proposal_context_version',
    });
  }
  const contextBytes = record['context_utf8_bytes'];
  if (
    contextBytes !== undefined &&
    (typeof contextBytes !== 'number' || !Number.isInteger(contextBytes) || contextBytes < 0)
  ) {
    throw invalid(file, lineNumber, 'context_utf8_bytes invalide.', { field: 'context_utf8_bytes' });
  }
  const contextSources = record['context_source_ids'];
  if (
    contextSources !== undefined &&
    (!Array.isArray(contextSources) ||
      contextSources.some((id) => typeof id !== 'string' || id.length === 0))
  ) {
    throw invalid(file, lineNumber, 'context_source_ids invalide.', { field: 'context_source_ids' });
  }

  return {
    // Sa propre version, jamais la constante : un enregistrement v2 relu ne
    // doit pas ressortir en v1, ce qui altérerait sa provenance.
    schema_version: schemaVersion,
    kind: 'DISPATCH_COMMITTED',
    invocation_id: invocationId,
    run_id: requireString(record, 'run_id', file, lineNumber),
    identity: validateInvocationIdentity(record['identity'], file, lineNumber),
    trigger_kind: trigger as InvocationTriggerKind,
    ...(optionalString(record, 'session_id', file, lineNumber) === undefined
      ? {}
      : { session_id: optionalString(record, 'session_id', file, lineNumber) as string }),
    ...(round === undefined ? {} : { round }),
    ...(optionalString(record, 'prompt_event_id', file, lineNumber) === undefined
      ? {}
      : { prompt_event_id: optionalString(record, 'prompt_event_id', file, lineNumber) as string }),
    ...(optionalString(record, 'source_event_id', file, lineNumber) === undefined
      ? {}
      : { source_event_id: optionalString(record, 'source_event_id', file, lineNumber) as string }),
    ...(optionalString(record, 'operation_id', file, lineNumber) === undefined
      ? {}
      : { operation_id: optionalString(record, 'operation_id', file, lineNumber) as string }),
    // L'audit traverse la revalidation : cette fonction **reconstruit** le
    // record avant écriture, si bien qu'un champ non repris ici disparaîtrait
    // silencieusement du journal.
    ...(contextVersion === undefined ? {} : { proposal_context_version: contextVersion }),
    ...(contextSources === undefined
      ? {}
      : { context_source_ids: [...(contextSources as readonly string[])] }),
    ...(contextBytes === undefined ? {} : { context_utf8_bytes: contextBytes }),
    ...(optionalString(record, 'context_sha256', file, lineNumber) === undefined
      ? {}
      : { context_sha256: optionalString(record, 'context_sha256', file, lineNumber) as string }),
    dispatch_committed_at: requireString(record, 'dispatch_committed_at', file, lineNumber),
  };
}

export function validateUsageObservationRecord(
  value: unknown,
  lineNumber: number | null = null,
): UsageObservationRecord {
  const file = 'usage.jsonl';
  const record = asRecord(value, file, lineNumber);

  if (record['schema_version'] !== USAGE_LEDGER_SCHEMA_VERSION) {
    throw invalid(file, lineNumber, `schema_version non pris en charge (${String(record['schema_version'])}).`, {
      field: 'schema_version',
    });
  }

  for (const forbidden of USAGE_FORBIDDEN_FIELDS) {
    if (forbidden in record) {
      throw invalid(
        file,
        lineNumber,
        `« ${forbidden} » n'a pas de sens dans un journal d'usage : la controverse est canonique ailleurs.`,
        { field: forbidden },
      );
    }
  }

  const observationId = requireString(record, 'usage_observation_id', file, lineNumber);
  if (parseUsageObservationSequence(observationId) === undefined) {
    throw invalid(file, lineNumber, `usage_observation_id non canonique (${observationId}).`, {
      field: 'usage_observation_id',
    });
  }

  const invocationId = requireString(record, 'invocation_id', file, lineNumber);
  if (parseInvocationSequence(invocationId) === undefined) {
    throw invalid(file, lineNumber, `invocation_id non canonique (${invocationId}).`, { field: 'invocation_id' });
  }

  const provenance = record['provenance'];
  if (typeof provenance !== 'string' || !(USAGE_PROVENANCES as readonly string[]).includes(provenance)) {
    throw invalid(file, lineNumber, `provenance inconnue (${String(provenance)}).`, { field: 'provenance' });
  }

  const outcome = record['outcome'];
  if (outcome !== undefined && (typeof outcome !== 'string' || !(USAGE_OUTCOMES as readonly string[]).includes(outcome))) {
    throw invalid(file, lineNumber, `outcome inconnu (${String(outcome)}).`, { field: 'outcome' });
  }

  const stage = record['failure_stage'];
  if (stage !== undefined && (typeof stage !== 'string' || !(USAGE_FAILURE_STAGES as readonly string[]).includes(stage))) {
    throw invalid(file, lineNumber, `failure_stage inconnu (${String(stage)}).`, { field: 'failure_stage' });
  }

  // Les blocs d'observation sont transportés tels que l'adapter les a produits.
  // Ce module valide leur place, pas leur arithmétique : recalculer un total
  // ici en ferait une seconde autorité sur ce que le fournisseur a rapporté.
  return {
    ...(record as unknown as UsageObservationRecord),
    schema_version: USAGE_LEDGER_SCHEMA_VERSION,
    usage_observation_id: observationId,
    invocation_id: invocationId,
    run_id: requireString(record, 'run_id', file, lineNumber),
    observed_at: requireString(record, 'observed_at', file, lineNumber),
    provenance: provenance as UsageProvenance,
  };
}

// --------------------------------------------------------------------------
// Intégrité composite
// --------------------------------------------------------------------------

/**
 * Observations dont l'invocation n'existe pas dans le journal d'invocations.
 *
 * Le lecteur d'une ligne d'usage reste **purement structurel** : exiger la
 * présence de l'invocation à la lecture ferait du journal d'usage une source
 * d'invocations, et un fichier tronqué rendrait illisible un usage par ailleurs
 * valide. La cohérence croisée est donc une vérification composite, explicite,
 * et rendue au diagnostic plutôt que levée.
 */
export function findOrphanUsageObservations(
  invocations: readonly InvocationDispatchRecord[],
  observations: readonly UsageObservationRecord[],
): readonly UsageObservationRecord[] {
  const known = new Set(invocations.map((entry) => entry.invocation_id));
  return observations.filter((observation) => !known.has(observation.invocation_id));
}

export type { RunExecutionMode };
