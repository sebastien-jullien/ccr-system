/**
 * Sémantique locale du détecteur V3 — bloc 7-A du plan gelé.
 *
 * Ce module transforme une **sortie non fiable**, potentiellement produite plus
 * tard par un modèle, en zéro ou plusieurs **propositions** de relation. Il
 * n'appelle aucun fournisseur, n'écrit aucun journal, ne lit aucun fichier et
 * n'a aucune horloge : c'est une fonction pure, et la tranche 7-A est
 * entièrement éprouvable sans qu'aucun modèle n'ait jamais été invoqué.
 *
 * ## La chaîne, dans cet ordre, et sans raccourci
 *
 * ```text
 * sortie non fiable
 * → bornée en taille AVANT parsing
 * → parseur déterministe
 * → validation de schéma, versionnée et locale au détecteur
 * → validation de forme du domaine
 * → zéro ou plusieurs inférences de relation CCR PROPOSÉES
 * ```
 *
 * Jamais `JSON.parse` → transtypage → persistance. Rien de ce qui sort d'ici
 * n'est une entrée de journal : la persistance appartient au service CCR, et à
 * lui seul.
 *
 * ## Les deux issues qu'il ne faut jamais confondre
 *
 * ```text
 * VALIDE, ZÉRO PROPOSITION   le détecteur a répondu, et n'a rien proposé
 * SORTIE INVALIDE            le détecteur a répondu quelque chose d'inutilisable
 * ```
 *
 * Les deux laisseront le journal V3 inchangé, mais elles ne disent pas la même
 * chose. C'est pourquoi le résultat est une **union discriminée** et non une
 * liste éventuellement vide accompagnée d'une exception : un appelant ne peut
 * pas lire `proposals` sans avoir d'abord constaté `VALID`, et il ne peut donc
 * pas replier un refus sur `[]` par distraction. La distinction est
 * structurelle, pas conventionnelle.
 *
 * ## Ce qu'une proposition n'est pas
 *
 * Une proposition n'affirme pas qu'un désaccord existe, qu'un expert a tort,
 * qu'une position est vraie, ni qu'une relation est fondée. Elle enregistre
 * qu'une sortie structurée **propose** telle relation attribuée à CCR. Aucun
 * score, aucune confiance, aucune vérité : le contrat a refusé qu'un seuil
 * fasse une autorité, et il n'existe donc aucun champ où en loger un.
 *
 * ## Ce que ce module ne décide pas
 *
 * Il valide des **formes**. L'existence réelle des entrées visées, leur
 * appartenance à la même controverse, la nature de leur type et leur provenance
 * exigent les faits canoniques sous le verrou de run — et ces contrôles vivent
 * déjà dans le service de mutation. Les refaire ici en créerait une seconde
 * autorité, qui divergerait.
 */

import {
  RELATION_ACTS,
  formatControversyEntryId,
  formatControversyId,
  parseControversyEntrySequence,
  parseControversySequence,
} from '../core/controversy.ts';
import type { RelationAct } from '../core/controversy.ts';
import { utf8ByteLength } from './transfer.ts';
import { CcrError } from '../core/errors.ts';
import type { ExpertSlotId, ProviderKind } from '../core/expert.ts';
import type { AgentAdapter, AgentTurnResult } from '../adapters/agent-adapter.ts';
import { runPaths } from '../store/layout.ts';
import { openInvocationLedger } from '../store/invocation-ledger.ts';
import { openUsageLedger } from '../store/usage-ledger.ts';
import { readStableNativeRunSnapshot } from '../store/native-run-snapshot.ts';
import { CONTROVERSY_DETECTION_TRIGGER } from '../core/usage-governance.ts';
import type { ControversyEntry } from '../core/controversy.ts';
import { assertInvocationQuotaAvailable } from './invocation-quota.ts';
import { createUsageRecorder, recordTurnUsage } from './usage-governance-writer.ts';
import { projectControversyReadModel } from './controversy-read-model.ts';
import { recordDetectedRelations } from './controversy-service.ts';
import { runtimeSettingsOf } from './native-start-service.ts';
import type { RunRuntimeSettings } from './run-service.ts';
import { withNativeMutation } from './native-mutation-boundary.ts';

// --------------------------------------------------------------------------
// Version et borne
// --------------------------------------------------------------------------

/**
 * Version du format de sortie du détecteur.
 *
 * **Distincte** de `CONTROVERSY_SCHEMA_VERSION` (journal V3), de
 * `INVOCATION_LEDGER_SCHEMA_VERSION` (ledger V2.2) et de
 * `CONTROVERSY_READ_MODEL_VERSION` (projection de lecture) : quatre domaines,
 * quatre versions. Les confondre ferait dépendre le format d'un contrat que
 * personne n'a signé.
 */
export const CONTROVERSY_DETECTOR_OUTPUT_VERSION = 1;

/** Versions que ce parseur sait lire. Une valeur hors liste est un refus. */
export const SUPPORTED_DETECTOR_OUTPUT_VERSIONS: readonly number[] = [
  CONTROVERSY_DETECTOR_OUTPUT_VERSION,
];

/**
 * Plafond de la sortie brute, en octets UTF-8.
 *
 * Aucun nombre n'est inventé : le plan gelé cartographie explicitement la
 * « sortie brute du détecteur » sur le **plafond de corps de requête** du
 * dépôt, qui vaut 1 MiB. La valeur est reprise ici plutôt qu'importée de la
 * couche HTTP, qu'un service ne doit pas connaître.
 *
 * La borne s'applique **avant** toute analyse : aucun document arbitrairement
 * gros n'est d'abord chargé dans une structure complète pour être mesuré
 * ensuite. Refus, jamais troncature — une sortie tronquée serait analysée comme
 * si elle était entière.
 */
export const MAX_DETECTOR_OUTPUT_BYTES = 1024 * 1024;

// --------------------------------------------------------------------------
// Formes
// --------------------------------------------------------------------------

/**
 * Une relation **proposée**, et rien de plus.
 *
 * Elle relie deux entrées par leur identité. Aucun objet `Position` n'existe :
 * la continuité est une relation attribuée, et une identité partagée n'en
 * porterait aucune.
 *
 * Elle ne porte ni `entry_id`, ni `schema_version`, ni `recorded_at`, ni
 * `recorded_by`, ni `semantic_origin`, ni `derivation`, ni `invocation_id` :
 * tous ces champs relèvent d'une autorité que le modèle n'a pas, et le schéma
 * les refuse plutôt que de les ignorer.
 */
export interface ProposedRelationInference {
  readonly controversy_id: string;
  readonly from_entry_id: string;
  readonly to_entry_id: string;
  readonly act: RelationAct;
}

/** Motifs de refus — fermés, publics, stables. */
export const DETECTOR_OUTPUT_REFUSAL_REASONS = [
  'OUTPUT_TOO_LARGE',
  'INVALID_JSON',
  'UNSUPPORTED_OUTPUT_VERSION',
  'INVALID_OUTPUT_SHAPE',
  'INVALID_PROPOSAL',
] as const;
export type DetectorOutputRefusalReason = (typeof DETECTOR_OUTPUT_REFUSAL_REASONS)[number];

/**
 * Issue de l'analyse — union discriminée.
 *
 * `VALID` avec `proposals: []` est un **succès** : la sortie était lisible et ne
 * proposait rien. `INVALID` est autre chose, et aucune des deux ne se déduit de
 * l'autre.
 */
export type DetectorOutputParse =
  | {
      readonly outcome: 'VALID';
      readonly detector_output_version: number;
      /** Ordre de production préservé — jamais retrié. */
      readonly proposals: readonly ProposedRelationInference[];
    }
  | {
      readonly outcome: 'INVALID';
      readonly reason: DetectorOutputRefusalReason;
      /** Chemin de validation stable, sans pile ni interne volatile. */
      readonly at: string;
    };

function invalid(reason: DetectorOutputRefusalReason, at: string): DetectorOutputParse {
  return { outcome: 'INVALID', reason, at };
}

// --------------------------------------------------------------------------
// Analyse
// --------------------------------------------------------------------------

const OUTPUT_KEYS: readonly string[] = ['detector_output_version', 'proposals'];
const PROPOSAL_KEYS: readonly string[] = ['controversy_id', 'from_entry_id', 'to_entry_id', 'act'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Refuse tout champ étranger.
 *
 * Même doctrine que le journal d'invocations : un champ inconnu est **refusé**,
 * jamais ignoré. Un modèle qui glisserait `confidence`, `semantic_origin` ou
 * `invocation_id` ne doit pas pouvoir devenir une autorité par omission — et
 * l'ignorer en silence laisserait croire qu'il a été pris en compte.
 */
function hasOnly(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

/**
 * Exige la forme **exactement canonique** d'un identifiant.
 *
 * Reconnaître le motif ne suffit pas ici, et c'est une différence de frontière,
 * pas une sévérité gratuite : le domaine ne voyait jusqu'ici que des
 * identifiants que CCR avait lui-même produits, tandis que cette entrée-ci est
 * non fiable. Or le motif de séquence n'est pas borné, et un remplissage de
 * zéros arbitrairement long désigne la même séquence — `ctv_` suivi de deux
 * cent mille chiffres reste analysable en `1`.
 *
 * La règle retenue n'invente aucune longueur : l'identifiant doit être
 * **celui que le formateur du domaine aurait écrit** pour cette séquence. Toute
 * autre écriture est refusée, sans être « réparée ».
 */
function canonicalIdentity(
  value: unknown,
  parse: (id: string) => number | undefined,
  format: (sequence: number) => string,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const sequence = parse(value);
  if (sequence === undefined || !Number.isSafeInteger(sequence) || sequence < 1) return undefined;
  return format(sequence) === value ? value : undefined;
}

function parseProposal(value: unknown, at: string): ProposedRelationInference | DetectorOutputParse {
  if (!isPlainObject(value)) return invalid('INVALID_PROPOSAL', at);
  if (!hasOnly(value, PROPOSAL_KEYS)) return invalid('INVALID_PROPOSAL', `${at}.<champ inconnu>`);

  const controversyId = canonicalIdentity(
    value['controversy_id'],
    parseControversySequence,
    formatControversyId,
  );
  if (controversyId === undefined) return invalid('INVALID_PROPOSAL', `${at}.controversy_id`);

  const from = canonicalIdentity(
    value['from_entry_id'],
    parseControversyEntrySequence,
    formatControversyEntryId,
  );
  if (from === undefined) return invalid('INVALID_PROPOSAL', `${at}.from_entry_id`);

  const to = canonicalIdentity(
    value['to_entry_id'],
    parseControversyEntrySequence,
    formatControversyEntryId,
  );
  if (to === undefined) return invalid('INVALID_PROPOSAL', `${at}.to_entry_id`);

  // Contrainte purement locale : elle n'exige aucun journal. Une relation qui
  // se vise elle-même ne dit rien, quel que soit son acte.
  if (from === to) return invalid('INVALID_PROPOSAL', `${at}.to_entry_id`);

  // Vocabulaire du domaine, importé — jamais redéclaré. Aucun acte nouveau
  // n'est admis : ni SUPPORTS, ni AGREES_WITH, ni RESOLVES, ni SAME_POSITION.
  const act = value['act'];
  if (typeof act !== 'string' || !(RELATION_ACTS as readonly string[]).includes(act)) {
    return invalid('INVALID_PROPOSAL', `${at}.act`);
  }

  return { controversy_id: controversyId, from_entry_id: from, to_entry_id: to, act: act as RelationAct };
}

/**
 * Analyse une sortie de détection non fiable.
 *
 * Fonction **pure** et déterministe : aucune horloge, aucun aléa, aucun accès
 * disque, aucun réseau, aucun tri dépendant de la locale. Le même texte rend
 * toujours le même résultat, ou le même refus.
 *
 * Les propositions ne sont **pas** dédupliquées, ni exactement, ni par
 * similarité. Le plan n'impose aucun refus des doublons dans une même sortie,
 * et l'information brute est conservée telle qu'elle a été produite : c'est
 * l'autorité de persistance qui appliquera ses propres règles, avec le contexte
 * qu'elle seule possède.
 */
export function parseDetectorOutput(raw: string): DetectorOutputParse {
  // 1 — la borne, AVANT toute analyse.
  if (typeof raw !== 'string') return invalid('INVALID_OUTPUT_SHAPE', 'output');
  if (utf8ByteLength(raw) > MAX_DETECTOR_OUTPUT_BYTES) return invalid('OUTPUT_TOO_LARGE', 'output');

  // 2 — syntaxe.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalid('INVALID_JSON', 'output');
  }

  // 3 — schéma versionné, fermé.
  if (!isPlainObject(parsed)) return invalid('INVALID_OUTPUT_SHAPE', 'output');
  if (!hasOnly(parsed, OUTPUT_KEYS)) return invalid('INVALID_OUTPUT_SHAPE', 'output.<champ inconnu>');

  const version = parsed['detector_output_version'];
  if (typeof version !== 'number' || !SUPPORTED_DETECTOR_OUTPUT_VERSIONS.includes(version)) {
    // Une version inconnue est un refus, jamais une analyse « au mieux ».
    return invalid('UNSUPPORTED_OUTPUT_VERSION', 'output.detector_output_version');
  }

  const proposals = parsed['proposals'];
  if (!Array.isArray(proposals)) return invalid('INVALID_OUTPUT_SHAPE', 'output.proposals');

  // 4 — forme du domaine, proposition par proposition. Le premier refus arrête
  // l'analyse : une sortie partiellement lisible n'est pas une sortie valide
  // amputée, c'est une sortie qu'on ne sait pas lire.
  const validated: ProposedRelationInference[] = [];
  for (let index = 0; index < proposals.length; index += 1) {
    const outcome = parseProposal(proposals[index], `output.proposals[${String(index)}]`);
    if ('outcome' in outcome) return outcome;
    validated.push(outcome);
  }

  return {
    outcome: 'VALID',
    detector_output_version: version,
    // Ordre de production préservé : le parseur ne crée aucune autorité d'ordre
    // intellectuel, et ne détruit pas non plus celle de la sortie.
    proposals: validated,
  };
}

// ==========================================================================
// Dispatch gouverné — bloc 7-B, trois phases
// ==========================================================================

/**
 * Détection assistée par modèle, gouvernée de bout en bout.
 *
 * ```text
 * PHASE A   verrou de run COURT
 *           faits canoniques → périmètre → inputs → quota → invocation_id
 *           → DISPATCH_COMMITTED durable
 *           → RELÂCHE
 *
 * PHASE B   HORS VERROU
 *           un seul appel d'adaptateur, jamais deux
 *
 * PHASE C   verrou de run COURT
 *           usage observé, puis relecture canonique, revalidation des
 *           propositions et persistance éventuelle
 * ```
 *
 * ## Pourquoi le verrou n'est pas tenu pendant l'appel
 *
 * Les quatre opérations natives qui appellent un fournisseur le tiennent parce
 * qu'elles **déplacent la machine d'état du run** : elles écrivent un événement
 * canonique, passent en `WAITING_AGENT` et déposent un `pending_operation`
 * portant l'état à restaurer. Une détection ne fait rien de tout cela — le
 * contrat lui interdit même d'écrire dans `events.jsonl`. Le round, le curseur
 * d'alternance, les sessions et le contrôle traversent l'opération intacts.
 *
 * Il n'y a donc **rien à reprendre**, et aucun `pending_operation` n'est créé.
 * L'incertitude d'une détection interrompue n'appartient pas au domaine de la
 * reprise du run : elle est déjà dite, exactement, par la combinaison
 * `DISPATCH_COMMITTED` présent · aucune observation d'usage · aucune relation
 * portant cet `invocation_id`.
 *
 * ## Un seul appel, jamais deux
 *
 * Aucun échec — de fournisseur, d'analyse, de domaine ou de persistance — ne
 * déclenche une seconde tentative. Un nouveau geste humain crée une **nouvelle**
 * invocation, avec sa propre identité et son propre engagement de budget.
 */

/** Fabrique d'adaptateurs, réduite à ce que la détection en utilise. */
export interface DetectionAdapters {
  readonly claude: AgentAdapter;
  readonly codex: AgentAdapter;
}

export interface DetectionDeps {
  readonly runsDir: string;
  now(): Date;
  createAdapters(cwd: string, runtime?: RunRuntimeSettings): DetectionAdapters;
}

/**
 * Le geste humain, tel qu'il est nommé.
 *
 * `expert_slot` désigne le moteur qui exécutera la détection. Le plan gelé
 * refuse explicitement de choisir un fournisseur — « le plan ne le fait pas :
 * il n'en a pas l'autorité » — le choix appartient donc à l'humain, et CCR en
 * dérive le fournisseur depuis le manifest plutôt que de le recevoir.
 */
export interface DetectionRequest {
  readonly runId: string;
  readonly controversy_id: string;
  readonly expert_slot: ExpertSlotId;
}

/**
 * Issue d'une détection — union discriminée.
 *
 * Les quatre branches sont des faits opérationnels distincts, et le type
 * empêche de les confondre. « Valide, zéro proposition » n'est pas un échec ;
 * « sortie invalide » n'est pas une panne de fournisseur ; et aucune des deux
 * ne signifie qu'il n'existe pas de controverse.
 */
export type DetectionOutcome =
  | {
      readonly kind: 'PERSISTED';
      readonly invocation_id: string;
      readonly entries: readonly ControversyEntry[];
      readonly controversy_revision: string;
    }
  | { readonly kind: 'VALID_ZERO'; readonly invocation_id: string }
  | {
      readonly kind: 'INVALID_OUTPUT';
      readonly invocation_id: string;
      readonly reason: DetectorOutputRefusalReason;
      readonly at: string;
    }
  | { readonly kind: 'PROVIDER_FAILED'; readonly invocation_id: string; readonly error_code: string };

/** Coutures de test. Aucune production n'en fournit. */
export interface DetectionSeams {
  /** Appelée quand le verrou de phase A est relâché et avant l'adaptateur. */
  readonly beforeProvider?: () => void | Promise<void>;
  readonly openInvocationLedger?: typeof openInvocationLedger;
  readonly openUsageLedger?: typeof openUsageLedger;
}

/** Ce que la phase A établit, et que la phase B consomme. */
interface DispatchPlan {
  readonly invocationId: string;
  readonly provider: ProviderKind;
  readonly cwd: string;
  readonly runtime: RunRuntimeSettings | undefined;
  readonly prompt: string;
  /** Références stables des entrées effectivement soumises au modèle. */
  readonly inputs: readonly string[];
}

// --------------------------------------------------------------------------
// Requête — la forme exacte que S7-A saura relire
// --------------------------------------------------------------------------

/**
 * Construit la demande adressée au modèle.
 *
 * Elle décrit **exactement** le format que `parseDetectorOutput` accepte, et
 * rien d'autre : demander un champ que le parseur refuserait ensuite serait
 * inviter une sortie invalide.
 *
 * Ce qui n'est jamais demandé : un gagnant, une confiance, un score, une
 * clôture, une nature, une position, une origine sémantique, une dérivation,
 * une invocation, un identifiant d'entrée. Le modèle **propose des relations**
 * entre des entrées existantes ; il ne juge pas le fond.
 */
export function buildDetectionPrompt(
  controversyId: string,
  entries: readonly ControversyEntry[],
): string {
  const lines = entries.map((entry) => {
    const text = entry.anchors.semantic?.text ?? entry.content ?? '';
    return `- ${entry.entry_id} · ${entry.kind} · ${text}`;
  });

  return [
    'Tu analyses les entrées enregistrées d’une controverse CCR.',
    '',
    `Controverse : ${controversyId}`,
    'Entrées :',
    ...lines,
    '',
    'Propose zéro ou plusieurs RELATIONS entre ces entrées.',
    'Une relation dit ce qu’une entrée FAIT à une autre. Elle n’affirme pas',
    'qu’une position est vraie, qu’un expert a raison, ni que la controverse',
    'est close.',
    '',
    `Actes admis, et eux seuls : ${RELATION_ACTS.join(', ')}.`,
    '',
    'Réponds UNIQUEMENT par un objet JSON de cette forme, sans texte autour :',
    '{',
    `  "detector_output_version": ${String(CONTROVERSY_DETECTOR_OUTPUT_VERSION)},`,
    '  "proposals": [',
    '    {',
    `      "controversy_id": "${controversyId}",`,
    '      "from_entry_id": "<identifiant d’entrée>",',
    '      "to_entry_id": "<identifiant d’entrée>",',
    '      "act": "<acte admis>"',
    '    }',
    '  ]',
    '}',
    '',
    'Aucun autre champ n’est accepté : ni confiance, ni score, ni gagnant, ni',
    'nature, ni position, ni origine, ni identifiant que tu aurais choisi.',
    'Si tu ne proposes aucune relation, rends une liste vide — c’est une',
    'réponse valide.',
  ].join('\n');
}

// --------------------------------------------------------------------------
// Phase A — sous verrou court
// --------------------------------------------------------------------------

async function planDetection(
  deps: DetectionDeps,
  request: DetectionRequest,
  seams: DetectionSeams,
): Promise<DispatchPlan> {
  const paths = runPaths(deps.runsDir, request.runId);

  return withNativeMutation(
    { runsDir: deps.runsDir, runId: request.runId, command: 'v3-detect-controversy' },
    async () => {
      const snapshot = await readStableNativeRunSnapshot(deps.runsDir, request.runId);

      // Périmètre : une controverse de ce run, et elle seule. Aucune détection
      // inter-run, aucune chronologie totale.
      const projection = projectControversyReadModel(snapshot);
      if (projection.availability !== 'AVAILABLE') {
        throw new CcrError('SCHEMA_VERSION_UNSUPPORTED', `Le run ${request.runId} ne porte pas de journal V3.`, {
          details: { runId: request.runId },
        });
      }
      const item = projection.items.find((candidate) => candidate.controversy_id === request.controversy_id);
      if (item === undefined || item.opening === null) {
        throw new CcrError('INVALID_ARGUMENT', `Aucune controverse ${request.controversy_id} enregistrée.`, {
          details: { reason: 'CONTROVERSY_NOT_FOUND', controversy_id: request.controversy_id },
        });
      }

      const binding = snapshot.manifest.experts[request.expert_slot];
      const prompt = buildDetectionPrompt(request.controversy_id, item.entries);
      // Les références stables sont capturées ICI, sur ce que le modèle voit —
      // jamais recalculées après la réponse comme s'il avait vu autre chose.
      const inputs = item.entries.map((entry) => entry.entry_id);

      // Quota AVANT engagement. Un refus ne crée aucune invocation, et
      // n'atteint jamais un adaptateur.
      await assertInvocationQuotaAvailable(paths, request.runId);

      const invocations = await (seams.openInvocationLedger ?? openInvocationLedger)(paths, request.runId);
      const dispatch = await invocations.append(
        {
          identity: {
            generation: 'NATIVE_V21_EXECUTION',
            expert_slot: request.expert_slot,
            provider: binding.provider,
          },
          trigger_kind: CONTROVERSY_DETECTION_TRIGGER,
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
        prompt,
        inputs,
      };
    },
  );
}

// --------------------------------------------------------------------------
// Orchestration
// --------------------------------------------------------------------------

/**
 * Exécute une détection demandée par un humain.
 *
 * Aucune surface publique n'appelle cette fonction : la disponibilité runtime
 * appartient au bloc 7-C, et aucun tour, aucun rafraîchissement et aucune
 * lecture ne la déclenche. Elle représente un geste explicite, et rien d'autre.
 */
export async function detectControversyRelations(
  deps: DetectionDeps,
  request: DetectionRequest,
  seams: DetectionSeams = {},
): Promise<DetectionOutcome> {
  const paths = runPaths(deps.runsDir, request.runId);

  // ---- PHASE A. Verrou court : rien d'externe ne s'exécute dedans.
  const plan = await planDetection(deps, request, seams);

  // ---- PHASE B. Hors verrou. Un seul appel, sans reprise ni second essai.
  await seams.beforeProvider?.();
  const adapters = deps.createAdapters(plan.cwd, plan.runtime);
  let turn: AgentTurnResult;
  try {
    turn = await adapters[plan.provider].start(plan.prompt);
  } catch (error) {
    // L'invocation reste un fait durable. Aucune observation d'usage n'est
    // inventée, et surtout aucune relation.
    return {
      kind: 'PROVIDER_FAILED',
      invocation_id: plan.invocationId,
      error_code: error instanceof CcrError ? error.code : 'UNEXPECTED',
    };
  }

  // ---- PHASE C. Verrou court, deux temps : l'usage observé, puis la
  // persistance éventuelle. Le verrou n'étant pas réentrant, ce sont deux
  // acquisitions successives, jamais imbriquées.
  await withNativeMutation(
    { runsDir: deps.runsDir, runId: request.runId, command: 'v3-detect-usage' },
    async () => {
      const recorder = createUsageRecorder(
        await (seams.openUsageLedger ?? openUsageLedger)(paths, request.runId),
        plan.invocationId,
        deps.now,
      );
      await recordTurnUsage(recorder, turn);
    },
  );

  // Le parseur de 7-A fait autorité, et il est le seul : aucune seconde
  // validation de schéma, aucun transtypage, aucune troncature.
  const parsed = parseDetectorOutput(turn.content);
  if (parsed.outcome === 'INVALID') {
    return {
      kind: 'INVALID_OUTPUT',
      invocation_id: plan.invocationId,
      reason: parsed.reason,
      at: parsed.at,
    };
  }
  if (parsed.proposals.length === 0) {
    // Succès de détection sans proposition. Ne signifie ni accord, ni absence
    // de controverse, ni résolution.
    return { kind: 'VALID_ZERO', invocation_id: plan.invocationId };
  }

  // Le périmètre et l'ensemble d'entrées viennent du plan de la phase A, jamais
  // d'une relecture : une entrée apparue pendant l'appel ne doit pas devenir
  // rétroactivement un fait « vu par le modèle ».
  const persisted = await recordDetectedRelations(deps, {
    runId: request.runId,
    invocation_id: plan.invocationId,
    controversy_id: request.controversy_id,
    inputs: plan.inputs,
    proposals: parsed.proposals,
  });

  return {
    kind: 'PERSISTED',
    invocation_id: plan.invocationId,
    entries: persisted.entries,
    controversy_revision: persisted.controversy_revision,
  };
}

// ==========================================================================
// Frontière de disponibilité — bloc 7-C
// ==========================================================================

/**
 * Trois faits **indépendants**, qu'aucun raisonnement ne doit fusionner.
 *
 * ```text
 * MODEL_DETECTION_IMPLEMENTED             la capacité technique existe (7-B)
 * MODEL_DETECTION_RUNTIME_AVAILABILITY    ce qu'un utilisateur peut déclencher
 * validation fournisseur RÉELLE           NOT_TESTED tant que S10 n'a pas eu lieu
 * ```
 *
 * « Implémenté » n'implique pas « disponible ». « Éprouvé avec un adaptateur de
 * test » n'implique pas « validé en réel ». Le précédent est celui de V2.2, qui
 * a livré l'estimateur de coût avec `PRODUCTION_PRICING_CURRENT = NONE` : la
 * capacité existait sans jamais produire un montant non validé.
 */
export const MODEL_DETECTION_IMPLEMENTED = true;

export type ModelDetectionAvailability = 'NOT_AVAILABLE' | 'AVAILABLE';

/**
 * Disponibilité **publique** du détecteur assisté par modèle.
 *
 * Ce n'est pas un diagnostic : elle n'affirme ni qu'un fournisseur répond, ni
 * qu'un quota reste, ni que le détecteur est juste, ni qu'un désaccord existe.
 * Elle dit une seule chose — **ce qu'un utilisateur est autorisé à déclencher
 * à cet instant**.
 *
 * Levée après le verdict `PASS` du micro-gate REAL — une invocation réellement
 * orchestrée, un ledger v2 réellement écrit, une réponse fournisseur réellement
 * obtenue, le parseur traversé sur elle, et une inférence réellement persistée.
 * Aucun fichier de validation, aucune préférence, aucun drapeau mutable : la
 * levée est un changement de code, adossé à une preuve citée.
 *
 * `AVAILABLE` dit exactement ceci : **un humain PEUT demander une détection**,
 * par `ccr detect`. Jamais qu'une détection se lance d'elle-même — aucun tour,
 * aucune lecture, aucun rafraîchissement n'en déclenche.
 */
export const MODEL_DETECTION_RUNTIME_AVAILABILITY: ModelDetectionAvailability = 'AVAILABLE';

/**
 * Issue d'une demande **publique** de détection.
 *
 * Union discriminée, comme l'issue du parseur : un appelant ne peut pas lire
 * une détection sans avoir d'abord constaté qu'elle a été dépêchée, et ne peut
 * donc pas prendre un refus de disponibilité pour un résultat vide.
 *
 * Le refus n'est pas une erreur de la requête — celle-ci peut être
 * parfaitement formée. C'est l'état du runtime qui l'interdit, et le dire par
 * une issue plutôt que par une exception rend l'absence d'effet lisible.
 */
export type PublicDetectionOutcome =
  | { readonly kind: 'NOT_AVAILABLE'; readonly availability: ModelDetectionAvailability }
  | { readonly kind: 'DISPATCHED'; readonly detection: DetectionOutcome };

/**
 * Demande **publique** de détection — la seule voie qu'une surface utilisateur
 * empruntera lorsqu'il y en aura une.
 *
 * La porte est franchie **avant** toute gouvernance : un refus ne lit aucun
 * run, n'alloue aucune identité, n'engage aucune invocation, n'appelle aucun
 * adaptateur et ne consomme aucun quota. Une porte fermée ne coûte rien.
 *
 * Aucune surface ne l'appelle aujourd'hui : le plan gelé n'active la surface
 * humaine retenue qu'**après** le verdict du micro-gate REAL.
 */
export async function requestModelDetection(
  deps: DetectionDeps,
  request: DetectionRequest,
  seams: DetectionSeams = {},
): Promise<PublicDetectionOutcome> {
  if (MODEL_DETECTION_RUNTIME_AVAILABILITY !== 'AVAILABLE') {
    return { kind: 'NOT_AVAILABLE', availability: MODEL_DETECTION_RUNTIME_AVAILABILITY };
  }
  return { kind: 'DISPATCHED', detection: await detectControversyRelations(deps, request, seams) };
}

/**
 * Autorisation du chemin d'acceptation contrôlé, réservé au micro-gate REAL.
 *
 * Elle n'est **pas** un paramètre que l'on demande : aucune surface publique
 * n'en construit, et rien de ce qui vient d'un corps HTTP, d'une requête, d'un
 * cookie, du frontend, des données d'un run, du contenu d'une controverse ou
 * de la sortie d'un fournisseur ne peut en produire une. Sa seule origine est
 * un appel interne écrit à la main pour ce gate.
 *
 * `humanAuthorization` consigne l'autorisation humaine explicite que le plan
 * exige ; elle n'est pas vérifiée par la machine — elle ne le pourrait pas —,
 * elle est **portée**, pour que l'appel dise qui l'a voulu.
 */
export interface ControlledAcceptanceAuthorization {
  readonly gate: 'S10_REAL_DETECTION_ACCEPTANCE';
  readonly humanAuthorization: string;
}

/**
 * Chemin d'acceptation contrôlé — ce qu'il franchit, et ce qu'il ne franchit
 * pas.
 *
 * ```text
 * FRANCHIT      la porte d'EXPOSITION PUBLIQUE, et elle seule —
 *               parce qu'il EST le mécanisme qui a décidé qu'elle pouvait être levée
 *
 * NE FRANCHIT   quota · InvocationLedger · DISPATCH_COMMITTED · adaptateur
 * PAS           parseur · validation de domaine · persistance
 * ```
 *
 * Il ne lit ni n'écrit `MODEL_DETECTION_RUNTIME_AVAILABILITY` : la levée de la
 * porte a été un changement de code adossé à son verdict, jamais un effet de
 * bord de son exécution. Il reste donc utilisable, à l'identique, pour une
 * prochaine acceptation — mais aucune surface publique ne l'atteint.
 *
 * Il appelle **le même** service gouverné que la voie publique. Il n'existe
 * donc qu'une seule autorité de quota, d'engagement, d'appel, d'analyse et de
 * persistance — pas deux pipelines à faire diverger.
 */
export async function runControlledAcceptanceDetection(
  deps: DetectionDeps,
  request: DetectionRequest,
  authorization: ControlledAcceptanceAuthorization,
  seams: DetectionSeams = {},
): Promise<DetectionOutcome> {
  if (authorization.gate !== 'S10_REAL_DETECTION_ACCEPTANCE') {
    throw new CcrError('INVALID_ARGUMENT', "Le chemin d'acceptation exige son autorisation de gate.", {
      details: { reason: 'ACCEPTANCE_AUTHORIZATION_REQUIRED' },
    });
  }
  if (typeof authorization.humanAuthorization !== 'string' || authorization.humanAuthorization.length === 0) {
    throw new CcrError('INVALID_ARGUMENT', "Le chemin d'acceptation exige une autorisation humaine enoncee.", {
      details: { reason: 'ACCEPTANCE_AUTHORIZATION_REQUIRED' },
    });
  }
  return detectControversyRelations(deps, request, seams);
}
