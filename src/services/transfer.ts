/**
 * Enveloppe de passage de témoin (spécification V1, §25, §26, §27).
 *
 * Deux règles gouvernent ce module.
 *
 * **Fidélité.** Le corps de la réponse source est transmis verbatim. CCR
 * n'a pas le droit de résumer, corriger, reformuler, extraire ce qu'il juge
 * pertinent, ni supprimer une partie du raisonnement ou des objections. Il
 * ajoute une enveloppe de protocole autour du texte, rien de plus.
 *
 * **Contradiction.** L'instruction transmise demande explicitement de chercher
 * à réfuter, pas à commenter. C'est ce qui a fait la valeur de l'expérience
 * initiale ; une consigne neutre la détruirait.
 *
 * Ce module est constitué de fonctions pures, sans accès disque ni processus.
 */

import { CcrError } from '../core/errors.ts';
import type { AgentKind, CcrEvent } from '../core/run.ts';

/**
 * Garde-fou CCR contre un transfert anormalement volumineux.
 *
 * Ce seuil n'est **pas** une limite de contexte Claude, ni une limite de
 * contexte Codex, ni une estimation de jetons : la V1 ne modélise rien de tout
 * cela. C'est une mesure déterministe en octets UTF-8, configurable, dont le
 * seul rôle est d'empêcher un transfert automatique déraisonnable.
 */
export const DEFAULT_MAX_TRANSFER_BYTES = 512 * 1024;

/**
 * Marqueurs d'encadrement du contenu source.
 *
 * Ils portent l'identifiant de l'événement source. Constaté sur un transfert
 * réel : un agent peut recopier l'enveloppe reçue dans sa propre réponse, et
 * celle-ci se retrouve alors imbriquée dans l'enveloppe suivante. Des
 * marqueurs fixes deviendraient ambigus ; qualifiés par l'événement, ils
 * restent distinguables sans qu'une seule ligne du contenu soit modifiée.
 */
export function beginMarker(sourceEventId: string): string {
  return `--- BEGIN ORIGINAL RESPONSE ${sourceEventId} ---`;
}

export function endMarker(sourceEventId: string): string {
  return `--- END ORIGINAL RESPONSE ${sourceEventId} ---`;
}

/** Consigne de contre-expertise transmise avec chaque passage de témoin. */
export const CROSS_REVIEW_INSTRUCTION = [
  "Examine cette réponse comme contre-expert. Cherche en priorité à réfuter ses",
  "affirmations, hypothèses, omissions et conclusions plutôt qu'à les confirmer.",
  "N'invente pas de désaccord : si un point résiste à la vérification, indique-le.",
  'Appuie tes objections sur des éléments vérifiables lorsque c\'est possible.',
].join('\n');

export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export interface TransferEnvelopeInput {
  readonly runId: string;
  readonly round: number;
  readonly sourceAgent: AgentKind;
  readonly sourceEventId: string;
  /** Contenu exact de la réponse source. */
  readonly content: string;
}

/**
 * Construit le message transmis à l'agent cible.
 *
 * `CONTENT_BYTES` donne la longueur exacte du texte original : elle reste
 * vérifiable sans qu'une partie du contenu ait été modifiée.
 */
export function buildTransferPrompt(input: TransferEnvelopeInput): string {
  return [
    `SOURCE: ${input.sourceAgent.toUpperCase()}`,
    `RUN: ${input.runId}`,
    `ROUND: ${String(input.round)}`,
    `SOURCE_EVENT: ${input.sourceEventId}`,
    `CONTENT_BYTES: ${String(utf8ByteLength(input.content))}`,
    '',
    beginMarker(input.sourceEventId),
    input.content,
    endMarker(input.sourceEventId),
    '',
    CROSS_REVIEW_INSTRUCTION,
  ].join('\n');
}

/** Agent destinataire d'un passage de témoin. La V1 en compte exactement deux. */
export function counterpartOf(agent: AgentKind): AgentKind {
  return agent === 'claude' ? 'codex' : 'claude';
}

export interface TransferSource {
  readonly event: CcrEvent;
  readonly agent: AgentKind;
  readonly content: string;
}

/**
 * Détermine la réponse d'agent à transférer.
 *
 * La garde `SOURCE_ALREADY_TRANSFERRED` est un
 * `DEFENSIVE INVARIANT — not a nominal workflow path` : dans la chaîne
 * nominale, chaque round abouti produit une réponse plus récente que la source
 * qu'il consomme, donc la source suivante est toujours neuve. Cette garde
 * protège contre un journal incohérent, un recovery mal résolu, une évolution
 * future du choix de source ou une tentative de rejeu explicite.
 *
 * La source vient exclusivement du journal CCR : la V1 ne lit jamais les
 * transcripts natifs pour reconstituer un contenu. La provenance reste donc
 * déterministe.
 *
 * Seul le **dernier** `assistant_response` est considéré. S'il a déjà servi de
 * source à un passage de témoin abouti, la recherche ne remonte pas plus loin :
 * rejouer un tour déjà transféré serait un ping-pong involontaire.
 *
 * Un `human_message` n'est jamais une source : `step` transfère une réponse
 * d'agent vers l'autre agent. Pour parler directement à un agent, il y a `send`.
 */
export function findTransferSource(events: readonly CcrEvent[]): TransferSource {
  let candidate: CcrEvent | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined) continue;
    if (event.type !== 'assistant_response') continue;
    if (event.actor !== 'claude' && event.actor !== 'codex') continue;
    if (typeof event.content !== 'string' || event.content.length === 0) continue;
    candidate = event;
    break;
  }

  if (candidate === undefined) {
    throw new CcrError(
      'NO_TRANSFERABLE_SOURCE',
      "Le journal ne contient aucune réponse d'agent transférable. Aucun prompt n'est inventé.",
      { details: { eventCount: events.length } },
    );
  }

  // La relation de consommation s'appuie sur `details.source_event_id`, et non
  // sur `based_on` : ce dernier porte toute la provenance du round — la source
  // *et* la réponse produite — et confondrait la réponse d'un round avec la
  // source qu'il a consommée, bloquant le passage de témoin suivant.
  const consumed = events.some(
    (event) => event.type === 'round_completed' && event.details?.['source_event_id'] === candidate.event_id,
  );
  if (consumed) {
    throw new CcrError(
      'SOURCE_ALREADY_TRANSFERRED',
      `La réponse ${candidate.event_id} a déjà été transférée. Attendez une nouvelle réponse d'agent.`,
      { details: { sourceEventId: candidate.event_id, sourceAgent: candidate.actor } },
    );
  }

  return { event: candidate, agent: candidate.actor as AgentKind, content: candidate.content as string };
}

// --------------------------------------------------------------------------
// Plan de passage de témoin — préconditions partagées
// --------------------------------------------------------------------------

/**
 * Toutes les préconditions de `step` connaissables depuis le snapshot, en un
 * seul endroit (V2-IMP-30, mini-gate 0C).
 *
 * Motif : la dérivation des capacités et le service `step` doivent répondre la
 * même chose. Les faire raisonner séparément sur la source, la session cible et
 * la taille du transfert reviendrait à écrire deux fois la même règle — et à la
 * laisser diverger, exactement le défaut `CLX2-A3`.
 *
 * La fonction est **pure** : elle ne lit rien, n'écrit rien, ne lève rien. Elle
 * transporte l'erreur que le service devra lever, afin que les messages et
 * codes publics restent identiques à ceux de la V1.
 */
export interface StepTransferPlanInput {
  readonly runId: string;
  /** Round visé, c'est-à-dire `state.round + 1`. */
  readonly round: number;
  readonly events: readonly CcrEvent[];
  readonly sessions: Readonly<Record<AgentKind, string | null>>;
  readonly state: string;
  /** Garde-fou effectif ; à défaut `DEFAULT_MAX_TRANSFER_BYTES`. */
  readonly maxTransferBytes?: number;
}

export type StepTransferBlockReason =
  | 'NO_TRANSFERABLE_SOURCE'
  | 'SOURCE_ALREADY_TRANSFERRED'
  | 'SESSION_MISSING'
  | 'PAYLOAD_TOO_LARGE_FOR_AUTOMATIC_TRANSFER';

export type StepTransferPlan =
  | {
      readonly kind: 'READY';
      readonly source: TransferSource;
      readonly targetAgent: AgentKind;
      readonly targetSessionId: string;
      readonly prompt: string;
      readonly bytes: number;
      readonly limit: number;
    }
  | {
      readonly kind: 'BLOCKED';
      readonly reason: StepTransferBlockReason;
      /** Erreur exacte que le service lèvera. */
      readonly error: CcrError;
      /** Renseignés lorsque le blocage survient après leur détermination. */
      readonly source?: TransferSource;
      readonly targetAgent?: AgentKind;
      readonly bytes?: number;
      readonly limit?: number;
    };

export function planStepTransfer(input: StepTransferPlanInput): StepTransferPlan {
  let source: TransferSource;
  try {
    source = findTransferSource(input.events);
  } catch (error) {
    if (!(error instanceof CcrError)) throw error;
    return {
      kind: 'BLOCKED',
      reason: error.code as StepTransferBlockReason,
      error,
    };
  }

  const targetAgent = counterpartOf(source.agent);
  const targetSessionId = input.sessions[targetAgent];
  if (targetSessionId === null) {
    return {
      kind: 'BLOCKED',
      reason: 'SESSION_MISSING',
      source,
      targetAgent,
      error: new CcrError('SESSION_MISSING', `Le run ${input.runId} n'a pas de session ${targetAgent}.`, {
        details: { runId: input.runId, agent: targetAgent, state: input.state },
      }),
    };
  }

  const prompt = buildTransferPrompt({
    runId: input.runId,
    round: input.round,
    sourceAgent: source.agent,
    sourceEventId: source.event.event_id,
    content: source.content,
  });
  const limit = input.maxTransferBytes ?? DEFAULT_MAX_TRANSFER_BYTES;
  const bytes = utf8ByteLength(prompt);

  if (bytes > limit) {
    return {
      kind: 'BLOCKED',
      reason: 'PAYLOAD_TOO_LARGE_FOR_AUTOMATIC_TRANSFER',
      source,
      targetAgent,
      bytes,
      limit,
      error: new CcrError(
        'PAYLOAD_TOO_LARGE_FOR_AUTOMATIC_TRANSFER',
        `Transfert de ${String(bytes)} octets refusé (limite ${String(limit)}). ` +
          "Le contenu source est conservé intact ; la décision revient à l'humain.",
        {
          details: {
            runId: input.runId,
            bytes,
            limit,
            sourceEventId: source.event.event_id,
            targetAgent,
          },
        },
      ),
    };
  }

  return { kind: 'READY', source, targetAgent, targetSessionId, prompt, bytes, limit };
}
