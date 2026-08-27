/**
 * Surface CLI V5 — la plus petite surface publique cohérente.
 *
 * Tranche S14 du plan gelé. Quatre commandes, orthographes fixées par le plan :
 *
 * ```text
 * ccr reconcile        acte humain complet — effets EXPLICITES et SÉPARÉS
 * ccr respond          réponse historique — ACCEPT | REJECT, sans effet
 * ccr reconciliation   lecture
 * ccr propose          proposition assistée — refusée tant que la porte est fermée
 * ```
 *
 * ## La CLI est une surface, jamais une autorité
 *
 * ```text
 * CLI PRESENTATION  ≠  BUSINESS AUTHORITY
 * CLI               ≠  STORE WRITER
 * FLAG              ≠  REAL-WORLD AUTHORITY
 * ```
 *
 * Elle n'ouvre aucun journal en écriture, ne valide aucun périmètre, ne calcule
 * aucune fraîcheur, ne vérifie aucune forme d'autorité, ne dérive aucune
 * actualité, ne produit aucune détection et n'interprète aucun désaccord. Elle
 * **assemble la requête contractée** et la remet à son propriétaire :
 *
 * ```text
 * reconcile · respond   →  services/reconciliation-service.ts   (S5 · S6 · S7 · S8)
 * reconciliation        →  services/reconciliation-read-model.ts (S12)
 * propose               →  services/reconciliation-proposer.ts   (S13)
 * ```
 *
 * Aucune valeur d'énumération n'est vérifiée ici — ni `scope_kind`, ni `mode`,
 * ni `relation`, ni le genre de provenance. Les transmettre telles quelles et
 * laisser le domaine refuser est la seule façon de n'avoir **aucune** seconde
 * autorité de validation.
 *
 * ## Fraîcheur des mutations humaines
 *
 * ```text
 * A  la CLI obtient une révision V5 courante HORS du verrou de mutation
 * B  cette valeur devient expected_revision
 * C  le service la revérifie SOUS son verrou, contre l'état relu
 * D  différence ⇒ REFUSED_FRESHNESS, aucun octet — et AUCUN rejeu ici
 * ```
 *
 * ```text
 * INTERDIT   réinjecter observed_revision comme expected_revision
 * INTERDIT   relire puis retenter automatiquement après un refus de fraîcheur
 * CLI CONVENIENCE  ≠  AUTHORIZATION TO RETRY
 * ```
 *
 * `ccr propose` **n'emploie pas** ce seam : `S13` tient sa propre référence
 * `R0`, capturée sous verrou avant le dispatch, et la revérifie en phase C.
 */

import { isCcrError } from '../core/errors.ts';
import type { Provenance } from '../core/reconciliation.ts';
import { readStableNativeRunSnapshot } from '../store/native-run-snapshot.ts';
import { readCurrentReconciliationRevision } from '../services/reconciliation-freshness.ts';
import {
  recordProposalResponse,
  recordReconciliation,
} from '../services/reconciliation-service.ts';
import type {
  RecordProposalResponseInput,
  RecordReconciliationInput,
} from '../services/reconciliation-service.ts';
import { projectReconciliationReadModel } from '../services/reconciliation-read-model.ts';
import { requestModelReconciliationProposal } from '../services/reconciliation-proposer.ts';
import type { ReconciliationProposerDeps } from '../services/reconciliation-proposer.ts';
import { resolveRunTarget } from './native-dispatch.ts';
import { formatReconciliationReadModel, formatRecordedEntry } from './reconciliation-format.ts';

// --------------------------------------------------------------------------
// Frontière d'entrée
// --------------------------------------------------------------------------

export interface ReconciliationCliArgs {
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, string>;
}

export interface ReconciliationCliIo {
  out(text: string): void;
  err(text: string): void;
}

/**
 * Dépendances de la surface.
 *
 * `createAdapters` n'est présent que parce que `S13` en a besoin : la CLI
 * n'importe **aucun** adaptateur de fournisseur et n'en construit aucun — elle
 * transmet la fabrique que le runtime lui remet.
 */
export type ReconciliationCliDeps = ReconciliationProposerDeps;

/**
 * Options admises, **par commande** — unions fermées.
 *
 * Le refus d'un drapeau inconnu appartient au parseur du point d'entrée, qui
 * lève sur toute option absente de ces listes : jamais ignorée, jamais devinée,
 * jamais corrigée.
 */
export const RECONCILE_FLAGS = [
  'run',
  'target',
  'scope-kind',
  'scope',
  'content',
  'provenance',
  'provenance-statement',
  'provenance-entry',
  'provenance-decision',
  'close',
  'withdraw-closure',
  'withdraw-scope',
  'withdraw-statement',
  'supersede',
  'supersede-scope',
  'responds-to',
  'relation',
  'adopted-option',
] as const;

export const RESPOND_FLAGS = [
  'run',
  'target',
  'proposal',
  'mode',
  'responded-option',
  'provenance',
  'provenance-statement',
  'provenance-entry',
  'provenance-decision',
] as const;

export const RECONCILIATION_READ_FLAGS = ['run'] as const;

export const PROPOSE_FLAGS = ['run', 'target', 'scope-kind', 'scope', 'expert'] as const;

const USAGE_EXIT = 2;
const ERROR_EXIT = 1;
const OK_EXIT = 0;

function missing(io: ReconciliationCliIo, name: string): number {
  io.err(`L'option --${name} est obligatoire.`);
  return USAGE_EXIT;
}

/** Une énumération explicite, telle que l'humain l'a écrite. Aucun tri. */
function listOf(value: string | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  return value.split(',').map((item) => item.trim());
}

/**
 * La provenance, assemblée **sans jugement**.
 *
 * Le genre est transmis tel quel, et chaque référence fournie est attachée sous
 * son nom canonique. Un genre inconnu, une référence manquante ou deux
 * références contradictoires sont refusés par le domaine — `V13` —, jamais ici.
 *
 * ```text
 * PROVENANCE  ≠  AUTHORITY
 * ```
 */
function provenanceOf(args: ReconciliationCliArgs): Provenance | undefined {
  const kind = args.flags.get('provenance');
  if (kind === undefined || kind.length === 0) return undefined;
  const assembled: Record<string, unknown> = { kind };
  const statement = args.flags.get('provenance-statement');
  const entry = args.flags.get('provenance-entry');
  const decision = args.flags.get('provenance-decision');
  if (statement !== undefined) assembled['statement'] = statement;
  if (entry !== undefined) assembled['entry_id'] = entry;
  if (decision !== undefined) assembled['decision_id'] = decision;
  return assembled as unknown as Provenance;
}

/**
 * Rend un refus **sans le réinterpréter**.
 *
 * L'issue et le motif viennent du service. La CLI ne convertit aucune cause :
 * un inconnu ne devient pas une panne, et une indisponibilité ne devient pas un
 * fournisseur hors ligne.
 */
function renderRefusal(io: ReconciliationCliIo, error: unknown): number {
  if (isCcrError(error)) {
    const details = error.details as { outcome?: string; reason?: string };
    const outcome = details.outcome ?? error.code;
    io.err(`Refusé : ${outcome}${details.reason === undefined ? '' : ` — ${details.reason}`}`);
    io.err(error.message);
    io.err('Aucun enregistrement V5 n\'a été écrit, et aucune reprise n\'a lieu.');
    return ERROR_EXIT;
  }
  io.err(`Erreur inattendue : ${error instanceof Error ? error.message : String(error)}`);
  return ERROR_EXIT;
}

// --------------------------------------------------------------------------
// `ccr reconcile` — acte humain
// --------------------------------------------------------------------------

/**
 * Assemble un acte humain et le remet au service.
 *
 * **Un effet n'existe que si le drapeau qui le déclare est présent.** Exécuter
 * la commande ne produit jamais une clôture, un retrait ni une supersession
 * (§10.5, `H3`) : les trois champs restent absents tant qu'aucun drapeau ne les
 * porte.
 *
 * La surface initiale déclare **une** relation de supersession par acte. Le
 * domaine en accepte plusieurs ; ce n'est pas une règle nouvelle, c'est la borne
 * de la plus petite surface publique cohérente, et elle est dite plutôt que tue.
 */
export async function commandReconcile(
  deps: ReconciliationCliDeps,
  args: ReconciliationCliArgs,
  io: ReconciliationCliIo,
): Promise<number> {
  const target = args.flags.get('target');
  if (target === undefined) return missing(io, 'target');
  const scopeKind = args.flags.get('scope-kind');
  if (scopeKind === undefined) return missing(io, 'scope-kind');
  const content = args.flags.get('content');
  if (content === undefined) return missing(io, 'content');
  const provenance = provenanceOf(args);
  if (provenance === undefined) return missing(io, 'provenance');

  const run = await resolveRunTarget(deps.runsDir, args.flags.get('run'));

  // ---- A · B. La référence de fraîcheur est obtenue HORS du verrou, et
  // devient `expected_revision`. Le service la revérifiera sous le sien.
  const expected = await readCurrentReconciliationRevision(
    { runsDir: deps.runsDir },
    run.runId,
  );

  const input: Record<string, unknown> = {
    runId: run.runId,
    expected_revision: expected,
    target_controversy_id: target,
    scope_kind: scopeKind,
    content,
    provenance,
  };
  const scope = listOf(args.flags.get('scope'));
  if (scope !== undefined) input['scope'] = scope;

  const closure = args.flags.get('close');
  if (closure !== undefined) input['closure'] = { declared: true, statement: closure };

  const withdrawn = listOf(args.flags.get('withdraw-closure'));
  if (withdrawn !== undefined) {
    input['closure_withdrawal'] = {
      declared: true,
      withdrawn_closures: withdrawn,
      withdrawal_scope: listOf(args.flags.get('withdraw-scope')) ?? [],
      statement: args.flags.get('withdraw-statement') ?? '',
    };
  }

  const superseded = args.flags.get('supersede');
  if (superseded !== undefined) {
    input['supersedes'] = [
      {
        superseded_act_id: superseded,
        supersession_scope: listOf(args.flags.get('supersede-scope')) ?? [],
      },
    ];
  }

  const proposal = args.flags.get('responds-to');
  if (proposal !== undefined) {
    const relation: Record<string, unknown> = {
      proposal_id: proposal,
      relation: args.flags.get('relation'),
    };
    const adopted = args.flags.get('adopted-option');
    if (adopted !== undefined) relation['adopted_option_id'] = adopted;
    input['responds_to'] = relation;
  }

  try {
    const result = await recordReconciliation(
      { runsDir: deps.runsDir, now: deps.now },
      input as unknown as RecordReconciliationInput,
    );
    io.out(`Acte humain enregistré — run ${result.runId}`);
    for (const line of formatRecordedEntry(result.entry.entry_id, result.reconciliation_revision)) {
      io.out(line);
    }
    io.out('');
    io.out(
      "Un acte enregistré n'est ni correct, ni opportun, ni définitif : CCR consigne " +
        "qu'il a été posé, et rien de plus.",
    );
    return OK_EXIT;
  } catch (error) {
    return renderRefusal(io, error);
  }
}

// --------------------------------------------------------------------------
// `ccr respond` — réponse historique
// --------------------------------------------------------------------------

/**
 * Enregistre une réponse humaine à une proposition.
 *
 * ```text
 * PROPOSAL_RESPONSE_RECORDED  ≠  RECONCILIATION_RECORDED
 * ACCEPT                      ≠  ADOPTS
 * REJECT                      ≠  retrait · supersession · acte humain
 * ```
 *
 * Aucune conversion n'existe ici : `ACCEPT` ne devient jamais une adoption, et
 * `REJECT` ne rouvre rien. Adopter une proposition demande `ccr reconcile
 * --responds-to … --relation ADOPTS`, c'est-à-dire un acte humain nouveau, avec
 * son contenu propre.
 */
export async function commandRespond(
  deps: ReconciliationCliDeps,
  args: ReconciliationCliArgs,
  io: ReconciliationCliIo,
): Promise<number> {
  const target = args.flags.get('target');
  if (target === undefined) return missing(io, 'target');
  const proposal = args.flags.get('proposal');
  if (proposal === undefined) return missing(io, 'proposal');
  const mode = args.flags.get('mode');
  if (mode === undefined) return missing(io, 'mode');
  const provenance = provenanceOf(args);
  if (provenance === undefined) return missing(io, 'provenance');

  const run = await resolveRunTarget(deps.runsDir, args.flags.get('run'));
  const expected = await readCurrentReconciliationRevision(
    { runsDir: deps.runsDir },
    run.runId,
  );

  const input: Record<string, unknown> = {
    runId: run.runId,
    expected_revision: expected,
    target_controversy_id: target,
    proposal_id: proposal,
    mode,
    provenance,
  };
  const option = args.flags.get('responded-option');
  if (option !== undefined) input['responded_option_id'] = option;

  try {
    const result = await recordProposalResponse(
      { runsDir: deps.runsDir, now: deps.now },
      input as unknown as RecordProposalResponseInput,
    );
    io.out(`Réponse enregistrée — run ${result.runId}`);
    for (const line of formatRecordedEntry(result.entry.entry_id, result.reconciliation_revision)) {
      io.out(line);
    }
    io.out('');
    io.out(
      "Une réponse est un fait historique sans effet : elle ne clôt rien, ne rouvre " +
        'rien, ne supersède rien et ne vaut pas adoption.',
    );
    return OK_EXIT;
  } catch (error) {
    return renderRefusal(io, error);
  }
}

// --------------------------------------------------------------------------
// `ccr reconciliation` — lecture
// --------------------------------------------------------------------------

/**
 * Rend le read model V5.
 *
 * Lecture pure : aucune révision de référence, aucun `expected_revision`, aucune
 * écriture. La composition appartient à `S12` ; cette commande obtient
 * l'instantané stable et met en forme ce que le read model rend.
 */
export async function commandReconciliationRead(
  deps: ReconciliationCliDeps,
  args: ReconciliationCliArgs,
  io: ReconciliationCliIo,
): Promise<number> {
  const run = await resolveRunTarget(deps.runsDir, args.flags.get('run'));
  const snapshot = await readStableNativeRunSnapshot(deps.runsDir, run.runId);
  io.out(formatReconciliationReadModel(projectReconciliationReadModel(snapshot)));
  return OK_EXIT;
}

// --------------------------------------------------------------------------
// `ccr propose` — proposition assistée
// --------------------------------------------------------------------------

/**
 * Demande une proposition assistée par modèle.
 *
 * La porte de disponibilité est **service-autoritaire** : aucun drapeau, aucune
 * variable d'environnement, aucune option de cette commande ne la lève. Tant
 * qu'elle est fermée, la commande rend l'indisponibilité **sans** appel
 * fournisseur, sans engagement d'invocation, sans enregistrement d'usage et sans
 * proposition canonique.
 *
 * ```text
 * NOT_AVAILABLE  ≠  fournisseur hors ligne · quota épuisé · sortie invalide
 * ```
 *
 * Le chemin d'acceptation contrôlée du micro-gate `G4` n'est **pas** exposé
 * ici : c'est une fonction distincte du service, avec son autorisation, et
 * aucune option de commande ne l'atteint.
 */
export async function commandPropose(
  deps: ReconciliationCliDeps,
  args: ReconciliationCliArgs,
  io: ReconciliationCliIo,
): Promise<number> {
  const target = args.flags.get('target');
  if (target === undefined) return missing(io, 'target');
  const scopeKind = args.flags.get('scope-kind');
  if (scopeKind === undefined) return missing(io, 'scope-kind');
  const expert = args.flags.get('expert');
  if (expert === undefined) return missing(io, 'expert');

  const run = await resolveRunTarget(deps.runsDir, args.flags.get('run'));
  const request: Record<string, unknown> = {
    runId: run.runId,
    target_controversy_id: target,
    scope_kind: scopeKind,
    expert_slot: expert,
  };
  const scope = listOf(args.flags.get('scope'));
  if (scope !== undefined) request['scope'] = scope;

  try {
    const outcome = await requestModelReconciliationProposal(
      deps,
      request as unknown as Parameters<typeof requestModelReconciliationProposal>[1],
    );

    if (outcome.kind === 'NOT_AVAILABLE') {
      io.err(
        `La proposition assistée par modèle n'est pas disponible sur ce runtime ` +
          `(${outcome.availability}).`,
      );
      io.err(
        "Ce refus ne dit rien d'un fournisseur, d'un quota ni d'une sortie : la porte " +
          "publique est fermée, et rien n'a été engagé.",
      );
      return ERROR_EXIT;
    }

    const proposal = outcome.proposal;
    io.out(`Run ${run.runId} — invocation ${proposal.invocation_id}`);
    switch (proposal.kind) {
      case 'RECORDED':
        io.out(
          `${String(proposal.entries.length)} proposition(s) CCR enregistrée(s) : ` +
            proposal.entries.map((entry) => entry.entry_id).join(', '),
        );
        io.out('');
        io.out(
          "Une proposition n'est pas une décision : elle reste d'origine CCR, sans effet, " +
            "et aucune de ses options n'est recommandée.",
        );
        return OK_EXIT;
      case 'VALID_ZERO':
        io.out('Sortie valide, aucune proposition.');
        io.out("Cela ne dit ni qu'un accord existe, ni qu'il n'y a rien à réconcilier.");
        return OK_EXIT;
      case 'INVALID_OUTPUT':
        io.err(`Sortie inexploitable (${proposal.reason}, ${proposal.at}).`);
        io.err("L'invocation reste enregistrée. Aucune proposition, et aucune reprise.");
        return ERROR_EXIT;
      case 'REVALIDATION_REFUSED':
        io.err(`Revalidation refusée (${proposal.check}) — ${proposal.detail}`);
        io.err("L'invocation reste enregistrée. Aucune proposition, et aucune reprise.");
        return ERROR_EXIT;
      case 'PROVIDER_FAILED':
        io.err(`Le moteur n'a pas rendu de sortie (${proposal.error_code}).`);
        io.err("L'invocation reste enregistrée. Aucune proposition, et aucune reprise.");
        return ERROR_EXIT;
    }
  } catch (error) {
    return renderRefusal(io, error);
  }
}
