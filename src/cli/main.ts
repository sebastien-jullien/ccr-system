/**
 * CLI CCR — adaptateur utilisateur (spécification V0.2, §43, §48).
 *
 * Ce module analyse des arguments, appelle un service et met en forme un
 * résultat. Il n'écrit jamais le manifest, l'état, le journal ou les rounds,
 * et ne connaît aucun format de sortie Claude ou Codex.
 *
 *   CLI (analyse / affichage) → services CCR → stores + adapters
 */

import { readFile } from 'node:fs/promises';

import { CcrError, isCcrError } from '../core/errors.ts';
import { isExpertSlotId } from '../core/expert.ts';
import { requestModelDetection } from '../services/controversy-detector.ts';
import { readCurrentEvidenceRevision } from '../services/evidence-freshness.ts';
import { adduceMaterial, registerMaterial } from '../services/evidence-service.ts';
import { requestModelAdduction } from '../services/evidence-adducer.ts';
import type { MaterialRepresentationInput } from '../services/evidence-service.ts';
import type { Orientation } from '../core/evidence.ts';
import { loadEffectiveConfig } from '../config/config-store.ts';
import { requirePinnedSnapshot, updateRunRuntimeConfig } from '../services/run-runtime-service.ts';
import { resolveRunsDir, runPaths } from '../store/layout.ts';
import { readInvocationOutcomeFacts } from '../services/invocation-outcome-read.ts';
import { loadRun } from '../store/state-store.ts';
import type { AgentKind, AgentRole } from '../core/run.ts';
import type { RunServiceDeps } from '../services/run-service.ts';
import {
  getRunStatus,
  handoffRun,
  pauseRun,
  recordDecision,
  recoverRun,
  resumeRun,
  sendMessage,
  stepRun,
  stopRun,
} from '../services/run-service.ts';
import { pauseNativeRun, resumeNativeRun } from '../services/native-control-service.ts';
import { startNativeRunWithPreflight } from '../services/native-start-service.ts';
import type { NativeExpertBindings } from '../services/native-start-service.ts';
import { stepNativeRun } from '../services/native-step-service.ts';
import { sendNativeMessage } from '../services/native-send-service.ts';
import { handoffNativeExpert } from '../services/native-handoff-service.ts';
import { parseNativeExpertTargetRef } from '../services/native-target-resolver.ts';
import { buildNativeRunReadModel } from '../services/native-read-model.ts';
import { listAnyRuns, readRunGeneration, resolveRunTarget } from './native-dispatch.ts';
import {
  PROPOSE_FLAGS,
  RECONCILE_FLAGS,
  RECONCILIATION_READ_FLAGS,
  RESPOND_FLAGS,
  commandPropose,
  commandReconcile,
  commandReconciliationRead,
  commandRespond,
} from './reconciliation-dispatch.ts';
import { formatNativeStatus } from './native-format.ts';
import { formatInvocationOutcomeFacts } from './invocation-outcome-format.ts';
import {
  isNativeRecoveryDomain,
  nativeRecoveryActionOf,
  isSupportedPair,
  requiresNote,
  runNativeRecovery,
  slugsOf,
  unsupportedPairError,
  NATIVE_RECOVERY_ACTION_SLUGS,
  NATIVE_RECOVERY_DOMAINS,
} from './native-recovery-dispatch.ts';
import {
  formatNativeRecoveryOverview,
  formatNativeRecoveryResult,
} from './native-recovery-format.ts';
import { isProviderKind } from '../core/expert.ts';
import type { ProviderKind } from '../core/expert.ts';
import type { StartPreflightDeps } from '../runtime/preflight-service.ts';
import { runDoctor } from '../services/doctor-service.ts';
import { clearStaleCockpitLock, startCockpit } from '../cockpit/cockpit-service.ts';
import type { DoctorDeps } from '../services/doctor-service.ts';
import { runSetup } from '../services/setup-service.ts';
import type { SetupDeps } from '../services/setup-service.ts';
import { createCliDeps } from './deps.ts';
import { formatDoctorReport } from './doctor-format.ts';
import { formatPreflightWarning } from './preflight-format.ts';
import { formatAgentResponse, formatList, formatStatus } from './format.ts';
import { formatNativeResponse } from './native-format.ts';
import { createTerminalPrompt } from './prompt.ts';
import path from 'node:path';
import { canonicalizeWorkspace } from '../services/start-mutation.ts';

const USAGE = `ccr — CCR · Contradictory Cross-Review

Usage :
  ccr start  --title <titre> (--prompt <texte> | --prompt-file <fichier>)
             [--cwd <répertoire>] [--runs-dir <répertoire>]
             [--author-provider <claude|codex>]
             [--challenger-provider <claude|codex>]
             [--max-invocations <entier >= 0>]
             Crée un run V2.1 : deux experts nommés « author » et
             « challenger », chacun exécuté par le moteur choisi. Par défaut
             author=claude et challenger=codex. Les deux experts peuvent
             partager le même moteur.
             Compatibilité : --claude-role / --codex-role restent acceptés
             lorsqu'ils décrivent exactement un author et un challenger. Ils
             sont dépréciés, et ne peuvent pas être combinés aux options
             ci-dessus.
             --max-invocations fixe la limite CCR d'appels model-producing
             pour CE run, et pour lui seul. Ce n'est ni un quota fournisseur,
             ni une limite de jetons, ni un plafond de dépense — CCR n'en
             connaît aucun. La valeur se pose à la création et n'est plus
             modifiable ; 0 interdit tout appel. Sans l'option, aucune limite
             CCR ne s'applique.

  ccr list   [--runs-dir <répertoire>]

  ccr status [<run_id>] [--runs-dir <répertoire>]

  ccr invocation-outcomes [<run_id>] [--invocation <invocation_id>]
             [--runs-dir <répertoire>]
             Lecture seule des faits dédiés d'issue d'invocation, dans leur
             ordre d'ajout persisté. Une seule source est lue, et aucune autre
             autorité n'est interrogée : ni registre d'engagement, ni
             transcript natif, ni usage, ni objet de domaine.
             Le filtre porte sur ce même ensemble. Un identifiant sans
             enregistrement rend zéro fait — une cardinalité, jamais un
             verdict : ni succès, ni échec, ni invocation inconnue.

  ccr send   <author|challenger> (<message> | --file <fichier>)
             [--run <run_id>] [--runs-dir <répertoire>]
             La cible est un expert. « claude » et « codex » restent acceptés
             comme alias de compatibilité, et sont refusés lorsque les deux
             experts partagent le moteur nommé.
             Sur un run historique, la cible reste <claude|codex>.

  ccr step   [--run <run_id>] [--runs-dir <répertoire>]
             Effectue un seul passage de témoin : la dernière réponse d'un
             agent est transmise verbatim à l'autre pour contre-expertise.

  ccr pause  [--run <run_id>] [--runs-dir <répertoire>]
             Suspend l'automatisation et rend la main. C'est le chemin normal
             vers « ccr handoff », qui exige un run suspendu.

  ccr resume [--run <run_id>] [--runs-dir <répertoire>]
             Rend le run à l'automatisation ; il ne lance aucun agent et
             n'efface aucun diagnostic de reprise. Refusé lorsque des faits
             canoniques se contredisent : CCR ne choisit pas lequel est vrai.

  ccr handoff <author|challenger> [--run <run_id>] [--runs-dir <répertoire>]
             Ouvre la session native dans la CLI officielle. Ne reprend jamais
             l'automatisation automatiquement.

  ccr material <run-event|text|ref> <valeur> [--label <texte>]
             [--run <run_id>] [--runs-dir <répertoire>]
             Enregistre un matériau dans le journal V4 : un événement du run,
             un texte fourni, ou un localisateur externe conservé tel quel —
             CCR ne le résout pas et n'observe pas son contenu.
             Enregistrer n'est pas verser au débat : aucune adduction n'est
             créée. Utilisez « ccr adduce » pour cela.

  ccr adduce <material_id> --target <ctve_id>
             --orientation <none|supports|objects-to>
             [--quote <texte> --occurrence <n>]
             [--run <run_id>] [--runs-dir <répertoire>]
             Verse un matériau au débat, à propos d'une entrée de controverse.
             L'orientation est obligatoire et n'a aucune valeur par défaut :
             elle dit votre position, jamais que la cible est vraie ou fausse.
             Les options --quote et --occurrence vont par paire.

  ccr adduce-model <material_id> --controversy <ctve_id>
             [--run <run_id>] [--runs-dir <répertoire>]
             Demande une adduction assistée par modèle : CCR soumet CE matériau
             détenu et les entrées de CETTE controverse, puis enregistre les
             rattachements que le modèle propose, s'ils traversent la
             revalidation. Le geste est humain : rien ne le déclenche
             automatiquement.
             --controversy attend l'ENTRÉE D'OUVERTURE de la controverse, en
             « ctve_ ». Un « ctv_ » n'est pas accepté, et n'est jamais converti.
             Le moteur est celui que le manifest lie à l'expert du run : il ne
             se choisit pas en ligne de commande.

  ccr detect <author|challenger> --controversy <ctv_id>
             [--run <run_id>] [--runs-dir <répertoire>]
             Demande une détection de controverse assistée par modèle sur UNE
             controverse enregistrée. Le geste est humain : rien ne la
             déclenche automatiquement. Le moteur est celui que le manifest lie
             à l'expert nommé — il ne se choisit pas en ligne de commande.
             Une sortie valide sans proposition est un succès : elle ne dit pas
             que les experts sont d'accord.

  ccr reconcile --target <ctv_id> --scope-kind <SUBSET|WHOLE> --content <texte>
             --provenance <genre> [--provenance-statement|-entry|-decision <v>]
             [--scope <ctve,…>] [--close <énoncé>]
             [--withdraw-closure <rcn,…> --withdraw-scope <ctve,…>
              --withdraw-statement <énoncé>]
             [--supersede <rcn> --supersede-scope <ctve,…>]
             [--responds-to <rcn> --relation <ADOPTS|MODIFIES|REPLACES>
              --adopted-option <id>] [--run <run_id>] [--runs-dir <répertoire>]
             Enregistre un acte humain de réconciliation. Chaque effet est
             DÉCLARÉ par son propre drapeau : exécuter la commande ne clôt rien,
             ne retire rien et ne supersède rien. L'acte existe indépendamment
             de toute proposition.

  ccr respond --target <ctv_id> --proposal <rcn_id> --mode <ACCEPT|REJECT>
             --provenance <genre> [--responded-option <id>]
             [--run <run_id>] [--runs-dir <répertoire>]
             Enregistre une réponse humaine à une proposition. Fait historique
             sans effet : ACCEPT ne vaut pas adoption, REJECT ne rouvre rien.

  ccr reconciliation [--run <run_id>] [--runs-dir <répertoire>]
             Lecture V5 : actes, propositions, réponses, périmètres, clôtures,
             retraits, supersessions, les DEUX actualités rendues séparément,
             détections et signaux de désaccord. N'écrit rien.

  ccr propose --target <ctv_id> --scope-kind <SUBSET|WHOLE> --expert <slot>
             [--scope <ctve,…>] [--run <run_id>] [--runs-dir <répertoire>]
             Demande une proposition assistée par modèle. Le geste est humain :
             rien ne le déclenche automatiquement. Le moteur est celui que le
             manifest lie à l'expert nommé — il ne se choisit pas en ligne de
             commande. Une proposition n'est jamais une décision.

  ccr decide (<texte> | --file <fichier>) [--run <run_id>] [--runs-dir <rép.>]
             Enregistre une décision humaine. Ne la transmet à aucun agent.
             Runs historiques uniquement : non portée au natif en V2.1, et
             refusée explicitement sur le run natif visé.

  ccr recover [--run <run_id>] [--acknowledge <note>] [--runs-dir <répertoire>]
             Run historique : nettoie un verrou périmé, finalise une opération
             dont la réponse est déjà journalisée, complète une initialisation
             partielle, ou matérialise une ambiguïté sans jamais rejouer un tour.

             Run natif : sans --domain/--action, n'écrit rien et affiche les
             quatre domaines de reprise avec leurs gestes actuellement permis.
             Une mutation nomme toujours son domaine et son geste :

               ccr recover --domain initialization --action continue
               ccr recover --domain step    --action finalize
               ccr recover --domain send    --action acknowledge-uncertainty
                                            --note "ce que vous avez constaté"
               ccr recover --domain handoff --action abort-before-interactive

             Ces exemples sont syntaxiques : les gestes réellement permis à cet
             instant sont ceux affichés par « ccr status », ou par
             « ccr recover » sans action. Aucun geste n'est choisi
             automatiquement, même lorsqu'un seul est disponible.

  ccr stop   [--run <run_id>] [--runs-dir <répertoire>]
             Clôt le run. Les sessions natives restent accessibles.
             Runs historiques uniquement : non portée au natif en V2.1, et
             refusée explicitement sur le run natif visé.

  ccr cockpit [--port <port>] [--runs-dir <répertoire>]
             Démarre le cockpit local sur 127.0.0.1. Un seul
             cockpit par data root : un second démarrage échoue avant d'ouvrir
             le moindre port. Arrêt par Ctrl-C ; le verrou est alors libéré.

  ccr cockpit clear-stale-lock --lock-id <identifiant> [--runs-dir <rép.>]
             Lève un verrou de cockpit local dont la péremption est démontrée,
             et uniquement celui dont l'identité est exactement fournie. Ne
             supprime jamais un verrou vivant, étranger ou indéterminable.

  ccr doctor Diagnostique l'installation locale : runtime, CLI fournisseurs,
             statut d'authentification rapporté, configuration et verrou.
             Ne modifie rien, n'interroge personne, ne requiert aucun terminal.

  ccr setup  Configure le poste : détecte Claude Code et Codex, rapporte leur
             statut d'authentification, propose leur connexion officielle après
             consentement explicite, et enregistre les préférences locales.
             Commande interactive : un terminal est requis. Ne crée aucun run.

Codes de sortie : 0 succès · 1 erreur CCR · 2 usage incorrect`;

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

const DEFAULT_IO: CliIo = {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
};

interface ParsedArgs {
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, string>;
}

class UsageError extends Error {}

function parseArgs(args: readonly string[], allowed: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }

    const separator = arg.indexOf('=');
    const name = separator === -1 ? arg.slice(2) : arg.slice(2, separator);
    if (!allowed.includes(name)) {
      throw new UsageError(`Option inconnue : --${name}`);
    }

    if (separator !== -1) {
      flags.set(name, arg.slice(separator + 1));
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new UsageError(`L'option --${name} attend une valeur.`);
    }
    flags.set(name, value);
    index += 1;
  }

  return { positionals, flags };
}

function requireFlag(parsed: ParsedArgs, name: string): string {
  const value = parsed.flags.get(name);
  if (value === undefined || value.length === 0) throw new UsageError(`L'option --${name} est obligatoire.`);
  return value;
}

/**
 * Limite CCR d'invocations d'un run, telle que la ligne de commande l'exprime.
 *
 * Refusée ici, avant le preflight et avant toute allocation : une option mal
 * formée ne doit pas laisser derrière elle un run que personne n'a demandé. La
 * conversion est stricte — « 3.5 », « 3 » suivi d'un espace ou « trois » ne
 * valent pas trois.
 */
function parseMaxInvocations(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-9]+$/.test(value)) {
    throw new UsageError(
      "--max-invocations attend un entier positif ou nul : le nombre d'appels " +
        "model-producing que CCR s'autorise sur ce run.",
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new UsageError("--max-invocations depasse ce qu'un entier JSON represente exactement.");
  }
  return parsed;
}

function parseRole(value: string | undefined, name: string): AgentRole | undefined {
  if (value === undefined) return undefined;
  if (value !== 'author' && value !== 'challenger') {
    throw new UsageError(`--${name} doit valoir "author" ou "challenger".`);
  }
  return value;
}

function parseAgent(value: string | undefined): AgentKind {
  if (value !== 'claude' && value !== 'codex') {
    throw new UsageError('Le destinataire doit être "claude" ou "codex".');
  }
  return value;
}

async function resolveText(inline: string | undefined, file: string | undefined, label: string): Promise<string> {
  if (inline !== undefined && file !== undefined) {
    throw new UsageError(`Choisissez soit ${label} en ligne, soit un fichier, pas les deux.`);
  }
  if (file !== undefined) return readFile(file, 'utf8');
  if (inline !== undefined && inline.length > 0) return inline;
  throw new UsageError(`${label} est obligatoire.`);
}

// --------------------------------------------------------------------------
// Commandes
// --------------------------------------------------------------------------

/**
 * Refus d'une commande de contrôle non portée au natif.
 *
 * `decide` et `stop` restent historiques en V2.1. Le point n'est pas de les
 * refuser — c'était déjà le cas — mais de le faire **sur le run réellement
 * visé** : la résolution historique sautait un run natif qu'elle ne savait pas
 * lire, et pouvait alors muter en silence un run legacy plus ancien, en
 * rapportant un succès.
 *
 * Le code n'est pas `SCHEMA_VERSION_UNSUPPORTED` : CCR lit parfaitement ce run.
 * C'est la commande qui n'existe pas pour cette génération, et le dire
 * autrement serait déguiser une limite de surface en erreur de lecture.
 */
function deferredNativeCommand(command: string, runId: string): CcrError {
  return new CcrError(
    'COMMAND_UNSUPPORTED_FOR_GENERATION',
    `\`ccr ${command}\` n'est pas portée aux runs natifs en V2.1. Le run visé est ${runId} ` +
      "(NATIVE_V21_EXECUTION) : aucun autre run n'a été touché.",
    { details: { command, runId, execution_mode: 'NATIVE_V21_EXECUTION' } },
  );
}

/** Chemin explicite éventuel d'une CLI fournisseur, partagé probes/adapters. */
function explicitExecutable(variable: string): { readonly executable?: string } {
  const value = process.env[variable];
  return value === undefined || value.length === 0 ? {} : { executable: value };
}

/**
 * `ccr start` — adaptateur de surface.
 *
 * La CLI analyse des arguments, appelle la façade applicative et met en forme
 * le résultat. Elle ne compose ni le preflight, ni le snapshot, ni
 * l'allocation : cette politique appartient à `startNativeRunWithPreflight`.
 *
 * Un run créé ici est **natif** : deux ExpertSlots, deux moteurs choisis, et
 * les schémas gelés de V2.1. La CLI continue de lire et d'opérer les runs
 * historiques, mais elle n'en crée plus.
 *
 * La façade native déclare elle-même un terminal absent (1C) : aucune
 * remédiation interactive n'est ouverte pendant une création, et la CLI n'en
 * fabrique donc plus.
 */
async function commandStart(
  parsed: ParsedArgs,
  io: CliIo,
  overrides: { deps?: RunServiceDeps; preflight?: StartPreflightDeps },
): Promise<number> {
  const prompt = await resolveText(parsed.flags.get('prompt'), parsed.flags.get('prompt-file'), 'Le contexte initial');
  const bindings = parseStartBindings(parsed);
  const title = requireFlag(parsed, 'title');
  const runsDir = parsed.flags.get('runs-dir');
  const maxInvocations = parseMaxInvocations(parsed.flags.get('max-invocations'));

  // Seams d'environnement du preflight, hors interaction : celle-ci est
  // construite séparément et ne peut pas être contournée.
  const { io: _injectedIo, confirm: _injectedConfirm, tty: _injectedTty, ...seams } =
    overrides.preflight ?? {};

  // Le preflight natif déclare lui-même un terminal absent (1C) : aucune
  // remédiation interactive n'est ouverte ici, et la CLI n'en fabrique pas.
  const result = await startNativeRunWithPreflight(
    {
      preflight: {
        // Mêmes chemins explicites que les adapters : un probe qui les
        // ignorerait diagnostiquerait une CLI absente sur une installation
        // parfaitement fonctionnelle (§7.1).
        agentOptions: {
          claude: explicitExecutable('CCR_CLAUDE_BIN'),
          codex: explicitExecutable('CCR_CODEX_BIN'),
        },
        ...seams,
      },
      createRunServiceDeps: (runtime) =>
        overrides.deps ??
        createCliDeps(runsDir, { codexSkipGitRepoCheck: runtime.codexSkipGitRepoCheck }),
      // Les avertissements sont émis avant toute allocation, à l'instant
      // exact où le preflight les produit.
      onPreflight: (preflight) => {
        for (const warning of preflight.warnings) io.out(formatPreflightWarning(warning));
      },
    },
    {
      title,
      // Même propriétaire de canonicalisation que le START du cockpit : le
      // workspace est une frontière de données, et deux points d'entrée ne
      // peuvent pas en produire deux formes différentes. `realpath` résout ici
      // jonctions et liens, comme là-bas.
      cwd: await canonicalizeWorkspace(path.resolve(parsed.flags.get('cwd') ?? process.cwd())),
      declaredCwd: parsed.flags.get('cwd') ?? process.cwd(),
      prompt,
      bindings,
      ...(maxInvocations === undefined ? {} : { maxInvocations }),
    },
  );

  io.out(`Run créé : ${result.runId}`);
  for (const position of result.positions) {
    io.out(`  ${position.slot} (${position.provider}) : session ${position.turn.sessionId}`);
  }

  if (result.failure !== undefined) {
    const { slot, error } = result.failure;
    io.err('');
    io.err(`Initialisation incomplète : la session de « ${slot} » n'a pas pu être créée.`);
    io.err(formatError(error));
    io.err('');
    io.err(`État : ${result.state.state}. Les sessions déjà créées sont conservées.`);
    return 1;
  }

  io.out(`État : ${result.state.state}`);
  return 0;
}

/**
 * Bindings d'un nouveau run, depuis la syntaxe canonique ou la compatibilité.
 *
 * ```text
 * canonique       --author-provider · --challenger-provider
 * compatibilité   --claude-role · --codex-role     (dépréciés)
 * ```
 *
 * Les deux familles ne se combinent pas : aucune priorité implicite n'est
 * inventée, et fournir les deux est une erreur d'usage. La compatibilité n'est
 * acceptée que lorsqu'elle décrit **exactement** un author et un challenger —
 * deux `author` ne décrivent aucun run possible.
 */
function parseStartBindings(parsed: ParsedArgs): Partial<NativeExpertBindings> {
  const canonical = {
    ...(parsed.flags.has('author-provider')
      ? { author: parseProvider(parsed.flags.get('author-provider'), 'author-provider') }
      : {}),
    ...(parsed.flags.has('challenger-provider')
      ? { challenger: parseProvider(parsed.flags.get('challenger-provider'), 'challenger-provider') }
      : {}),
  };
  const claudeRole = parseRole(parsed.flags.get('claude-role'), 'claude-role');
  const codexRole = parseRole(parsed.flags.get('codex-role'), 'codex-role');
  const legacyUsed = claudeRole !== undefined || codexRole !== undefined;

  if (Object.keys(canonical).length > 0 && legacyUsed) {
    throw new UsageError(
      'Les options --author-provider/--challenger-provider et --claude-role/--codex-role ' +
        'décrivent la même chose de deux façons : choisissez-en une.',
    );
  }
  if (!legacyUsed) return canonical;

  // Compatibilité : un rôle par moteur. Elle n'a de sens que si la
  // correspondance est bijective.
  const roles = { claude: claudeRole, codex: codexRole };
  const author = (['claude', 'codex'] as const).filter((provider) => roles[provider] === 'author');
  const challenger = (['claude', 'codex'] as const).filter(
    (provider) => roles[provider] === 'challenger',
  );
  if (author.length !== 1 || challenger.length !== 1) {
    throw new UsageError(
      '--claude-role et --codex-role doivent désigner exactement un « author » et un ' +
        '« challenger ». Utilisez --author-provider / --challenger-provider pour toute autre ' +
        'configuration, y compris deux experts sur le même moteur.',
    );
  }
  return { author: author[0] as ProviderKind, challenger: challenger[0] as ProviderKind };
}

function parseProvider(value: string | undefined, name: string): ProviderKind {
  if (!isProviderKind(value)) throw new UsageError(`--${name} doit valoir "claude" ou "codex".`);
  return value;
}

/**
 * `ccr list` — énumération **bi-génération**.
 *
 * La lecture appartient à la plomberie de génération, jamais aux services
 * historiques : ce sont eux qui déclaraient « (illisible) » un run natif
 * parfaitement sain, faute de savoir lire un manifest schema 2.
 */
async function commandList(deps: RunServiceDeps, io: CliIo): Promise<number> {
  io.out(formatList(await listAnyRuns(deps.runsDir)));
  return 0;
}

async function commandStatus(deps: RunServiceDeps, parsed: ParsedArgs, io: CliIo): Promise<number> {
  const target = await resolveRunTarget(deps.runsDir, parsed.positionals[0]);
  if (target.generation === 'NATIVE_V21_EXECUTION') {
    // La projection 2D est l'autorité : la CLI met en forme, et ne recalcule
    // ni capacité, ni source, ni reprise.
    io.out(formatNativeStatus(await buildNativeRunReadModel({ runsDir: deps.runsDir }, target.runId)));
    return 0;
  }
  io.out(formatStatus(await getRunStatus(deps, target.runId)));
  return 0;
}

/**
 * Lecture des faits dédiés d'issue d'invocation.
 *
 * La CLI est une surface : elle résout le run, remet la requête au service, et
 * met en forme ce qu'il rend. Elle n'ouvre aucun journal, n'interroge aucune
 * autre autorité, et ne déduit rien d'un résultat vide.
 */
async function commandInvocationOutcomes(
  deps: RunServiceDeps,
  parsed: ParsedArgs,
  io: CliIo,
): Promise<number> {
  const target = await resolveRunTarget(deps.runsDir, parsed.positionals[0]);
  const invocationId = parsed.flags.get('invocation');

  const view = await readInvocationOutcomeFacts(runPaths(deps.runsDir, target.runId), {
    ...(invocationId === undefined ? {} : { invocationId }),
  });

  io.out(formatInvocationOutcomeFacts(view));
  // Une requête exécutée est une réussite d'exécution CLI. La cardinalité du
  // résultat n'entre pas dans ce code : zéro fait n'est pas une erreur.
  return 0;
}

async function commandSend(deps: RunServiceDeps, parsed: ParsedArgs, io: CliIo): Promise<number> {
  const message = await resolveText(parsed.positionals[1], parsed.flags.get('file'), 'Le message');
  // La génération d'abord : « claude » ne désigne pas la même chose dans les
  // deux mondes, et le mot ne peut pas trancher pour le run.
  const target = await resolveRunTarget(deps.runsDir, parsed.flags.get('run'));
  const raw = parsed.positionals[0] ?? '';

  if (target.generation === 'NATIVE_V21_EXECUTION') {
    const result = await sendNativeMessage(
      deps,
      target.runId,
      parseNativeExpertTargetRef(raw),
      message,
    );
    io.out(formatNativeResponse(result.expertSlot, result.sessionId, result.response));
    io.out('');
    io.out(
      `Run ${result.runId} — état ${result.state.state}, contrôle ${result.state.control} ` +
        `(round ${String(result.state.round)}, curseur inchangé)`,
    );
    return 0;
  }

  const result = await sendMessage(deps, { agent: parseAgent(raw), message, runId: target.runId });
  io.out(formatAgentResponse(result.agent, result.sessionId, result.response));
  io.out('');
  io.out(`Run ${result.runId} — état ${result.state.state}, contrôle ${result.state.control}`);
  return 0;
}

async function commandStep(deps: RunServiceDeps, parsed: ParsedArgs, io: CliIo): Promise<number> {
  const target = await resolveRunTarget(deps.runsDir, parsed.flags.get('run'));

  if (target.generation === 'NATIVE_V21_EXECUTION') {
    // Source, cible, curseur, fraîcheur et garde-fou de taille appartiennent au
    // planificateur natif. La CLI n'en recalcule aucun.
    const native = await stepNativeRun(deps, target.runId);
    io.out(
      `Round ${String(native.round)} : ${native.sourceSlot} → ${native.targetSlot} ` +
        `(source ${native.sourceEventId}, ${String(native.transferredBytes)} octets)`,
    );
    io.out('');
    io.out(formatNativeResponse(native.targetSlot, native.targetSessionId, native.response));
    io.out('');
    io.out(
      `Run ${native.runId} — état ${native.state.state}, contrôle ${native.state.control}, ` +
        `curseur ${String(native.state.next_step_source_slot)}`,
    );
    return 0;
  }

  const result = await stepRun(deps, { runId: target.runId });

  io.out(
    `Round ${String(result.round)} : ${result.sourceAgent} → ${result.targetAgent} ` +
      `(source ${result.sourceEventId}, ${String(result.transferredBytes)} octets)`,
  );
  io.out('');
  io.out(formatAgentResponse(result.targetAgent, result.targetSessionId, result.response));
  io.out('');
  io.out(`Run ${result.runId} — état ${result.state.state}, contrôle ${result.state.control}`);
  return 0;
}

/**
 * `ccr pause` — suspension volontaire, dans les deux générations.
 *
 * La génération est établie **avant** le service, depuis les faits persistés du
 * run visé. C'est ce qui empêche qu'un run natif implicite soit silencieusement
 * sauté par un lecteur historique, au profit d'un run plus ancien.
 */
async function commandPause(deps: RunServiceDeps, parsed: ParsedArgs, io: CliIo): Promise<number> {
  const target = await resolveRunTarget(deps.runsDir, parsed.flags.get('run'));

  const result =
    target.generation === 'NATIVE_V21_EXECUTION'
      ? await pauseNativeRun(deps, target.runId)
      : await pauseRun(deps, { runId: target.runId });

  io.out(
    result.changed
      ? `Run ${result.runId} suspendu — état ${result.state.state}, contrôle ${result.state.control}`
      : `Run ${result.runId} déjà sous contrôle humain — état ${result.state.state} (inchangé)`,
  );
  return 0;
}

async function commandResume(deps: RunServiceDeps, parsed: ParsedArgs, io: CliIo): Promise<number> {
  const target = await resolveRunTarget(deps.runsDir, parsed.flags.get('run'));

  const result =
    target.generation === 'NATIVE_V21_EXECUTION'
      ? await resumeNativeRun(deps, target.runId)
      : await resumeRun(deps, { runId: target.runId });

  io.out(
    result.changed
      ? `Run ${result.runId} rendu à l'automatisation — état ${result.state.state}, contrôle ${result.state.control}`
      : `Run ${result.runId} déjà exécutable par l'automatisation — état ${result.state.state} (inchangé)`,
  );
  io.out("Aucun agent n'a été appelé. Utilisez `ccr step` pour le prochain passage de témoin.");
  return 0;
}

async function commandHandoff(deps: RunServiceDeps, parsed: ParsedArgs, io: CliIo): Promise<number> {
  const target = await resolveRunTarget(deps.runsDir, parsed.flags.get('run'));
  const raw = parsed.positionals[0] ?? '';

  if (target.generation === 'NATIVE_V21_EXECUTION') {
    const native = await handoffNativeExpert(deps, target.runId, parseNativeExpertTargetRef(raw));
    io.out('');
    io.out(
      `Handoff « ${native.expertSlot} » (${native.provider}) terminé ` +
        `(session ${native.sessionId}, ${String(native.durationMs)} ms).`,
    );
    io.out(`Run ${native.runId} — état ${native.state.state}, contrôle ${native.state.control}.`);
    io.out("CCR ne connaît pas le contenu de cette interaction : coût NOT CONTROLLED / NOT MEASURED.");
    return 0;
  }

  const result = await handoffRun(deps, { agent: parseAgent(raw), runId: target.runId });

  io.out('');
  io.out(`Handoff ${result.agent} terminé (session ${result.sessionId}, ${String(result.durationMs)} ms).`);
  io.out(`Run ${result.runId} — état ${result.state.state}, contrôle ${result.state.control}.`);
  io.out('La reprise reste une décision explicite : `ccr resume`.');
  return 0;
}

async function commandDecide(deps: RunServiceDeps, parsed: ParsedArgs, io: CliIo): Promise<number> {
  const content = await resolveText(parsed.positionals[0], parsed.flags.get('file'), 'La décision');
  const target = await resolveRunTarget(deps.runsDir, parsed.flags.get('run'));
  if (target.generation === 'NATIVE_V21_EXECUTION') throw deferredNativeCommand('decide', target.runId);

  const result = await recordDecision(deps, { content, runId: target.runId });

  io.out(`Décision ${result.decision.decision_id} enregistrée (${result.decision.status}).`);
  io.out(`Run ${result.runId} — état ${result.state.state}, contrôle ${result.state.control} (inchangés).`);
  io.out("Elle n'a été transmise à aucun agent. Utilisez `ccr send` pour l'expliquer à Claude ou Codex.");
  return 0;
}

/**
 * Formes de matériau, telles que la ligne de commande les nomme.
 *
 * Vocabulaire fermé, aligné sur les trois formes du contrat V4. Aucune
 * quatrième n'existe, et aucun alias n'est admis : un nom inventé désignerait
 * une forme que le contrat n'a pas ouverte.
 */
const MATERIAL_KINDS: Readonly<Record<string, MaterialRepresentationInput['form']>> = {
  'run-event': 'RUN_EVENT',
  text: 'INLINE_TEXT',
  ref: 'EXTERNAL_REFERENCE',
};

/**
 * Orientations, telles que la ligne de commande les nomme.
 *
 * `--orientation` est **obligatoire** et n'a aucune valeur par défaut : le
 * contrat interdit qu'une orientation absente puisse être reconstruite, et un
 * défaut implicite serait exactement cette reconstruction.
 */
const CLI_ORIENTATIONS: Readonly<Record<string, Orientation>> = {
  none: 'NONE',
  supports: 'SUPPORTS',
  'objects-to': 'OBJECTS_TO',
};

/**
 * Fraîcheur V4, obtenue **au moment du geste**.
 *
 * La CLI ne tient aucune vue préalable : elle observe l'état autoritaire au
 * début de son exécution, puis le service arbitre sous verrou. Si une mutation
 * concurrente s'insère entre les deux, la commande est refusée — et elle ne
 * relit rien, ne réessaie rien. Relancer est un nouveau geste, et il appartient
 * à l'humain.
 *
 * La CLI n'ouvre aucun journal et ne calcule aucune révision : le jeton vient
 * du service, et voyage jusqu'au service d'écriture sans être interprété.
 */
async function currentEvidenceRevision(deps: RunServiceDeps, runId: string): Promise<string> {
  return readCurrentEvidenceRevision({ runsDir: deps.runsDir }, runId);
}

/**
 * `ccr material` — enregistrer un matériau.
 *
 * Enregistrer dit que CCR détient ou identifie un objet, et **rien de plus**.
 * Aucune adduction n'est créée, ni automatiquement, ni sur option.
 */
async function commandMaterial(deps: RunServiceDeps, parsed: ParsedArgs, io: CliIo): Promise<number> {
  const kind = parsed.positionals[0] ?? '';
  const form = MATERIAL_KINDS[kind];
  if (form === undefined) {
    throw new UsageError('`ccr material` attend une forme : <run-event|text|ref>.');
  }

  const value = parsed.positionals[1];
  if (value === undefined || value.length === 0) {
    throw new UsageError(`\`ccr material ${kind}\` attend une valeur.`);
  }

  const label = parsed.flags.get('label');
  const target = await resolveRunTarget(deps.runsDir, parsed.flags.get('run'));

  // La forme est construite ici, la validation appartient au domaine et au
  // service : la CLI ne résout aucun événement et n'ouvre aucun localisateur.
  const representation: MaterialRepresentationInput =
    form === 'RUN_EVENT'
      ? { form, event_id: value }
      : form === 'INLINE_TEXT'
        ? { form, text: value }
        : { form, locator: value };

  const result = await registerMaterial(
    { runsDir: deps.runsDir, now: deps.now },
    {
      runId: target.runId,
      expected_evidence_revision: await currentEvidenceRevision(deps, target.runId),
      representation,
      ...(label === undefined ? {} : { label }),
    },
  );

  io.out(`Matériau ${result.entry.entry_id} enregistré (${form}).`);
  io.out(`Run ${result.runId} — fraîcheur V4 ${result.evidence_revision}`);
  io.out("Aucune adduction n'a été créée : enregistrer n'est pas verser au débat.");
  return 0;
}

/**
 * `ccr adduce` — verser un matériau au débat.
 *
 * Le fait enregistré est celui-ci, et lui seul : cet acteur a adduit ce
 * matériau à propos de cette cible, avec cette orientation. Il ne dit ni que la
 * cible est vraie, ni qu'elle est fausse.
 */
async function commandAdduce(deps: RunServiceDeps, parsed: ParsedArgs, io: CliIo): Promise<number> {
  const materialId = parsed.positionals[0];
  if (materialId === undefined || materialId.length === 0) {
    throw new UsageError('`ccr adduce` attend un identifiant de matériau : <material_id>.');
  }

  const targetEntryId = parsed.flags.get('target');
  if (targetEntryId === undefined || targetEntryId.length === 0) {
    throw new UsageError("L'option --target attend l'identifiant d'une entrée de controverse.");
  }

  const orientationFlag = parsed.flags.get('orientation');
  if (orientationFlag === undefined) {
    throw new UsageError(
      "L'option --orientation est obligatoire : <none|supports|objects-to>. " +
        "Elle n'a aucune valeur par défaut — une orientation absente ne se devine pas.",
    );
  }
  const orientation = CLI_ORIENTATIONS[orientationFlag];
  if (orientation === undefined) {
    throw new UsageError(`Orientation inconnue : ${orientationFlag}. Attendu <none|supports|objects-to>.`);
  }

  // Les deux vont par paire : l'une sans l'autre est une erreur d'usage, et le
  // refus tombe AVANT toute lecture et tout appel de service.
  const quote = parsed.flags.get('quote');
  const occurrenceFlag = parsed.flags.get('occurrence');
  if ((quote === undefined) !== (occurrenceFlag === undefined)) {
    throw new UsageError('`--quote` et `--occurrence` vont par paire : fournissez les deux, ou aucune.');
  }
  let occurrence: number | undefined;
  if (occurrenceFlag !== undefined) {
    if (!/^[0-9]+$/.test(occurrenceFlag)) {
      throw new UsageError(`L'option --occurrence attend un rang entier : ${occurrenceFlag}`);
    }
    occurrence = Number.parseInt(occurrenceFlag, 10);
  }

  const target = await resolveRunTarget(deps.runsDir, parsed.flags.get('run'));

  const result = await adduceMaterial(
    { runsDir: deps.runsDir, now: deps.now },
    {
      runId: target.runId,
      expected_evidence_revision: await currentEvidenceRevision(deps, target.runId),
      material_id: materialId,
      target_entry_id: targetEntryId,
      orientation,
      ...(quote === undefined || occurrence === undefined
        ? {}
        : { citation: { quoted_text: quote, occurrence } }),
    },
  );

  io.out(`Adduction ${result.entry.entry_id} — ${materialId} ${orientation} ${targetEntryId}.`);
  io.out(`Run ${result.runId} — fraîcheur V4 ${result.evidence_revision}`);
  io.out(
    orientation === 'NONE'
      ? "Aucune orientation déclarée : cela ne dit pas que la pièce est sans pertinence."
      : "Cela n'établit pas que la cible est vraie : c'est votre position, enregistrée.",
  );
  return 0;
}

/**
 * `ccr adduce-model` — la surface humaine de l'adduction assistée par modèle.
 *
 * Activée après le verdict `PASS` du micro-gate REAL de S10, et selon la seule
 * surface que le plan gelé retienne au premier palier : la CLI.
 *
 * ## Ce que cette commande n'est pas
 *
 * Elle n'est **pas** la voie d'acceptation contrôlée du gate : celle-ci reste
 * interne, et aucun argument ne peut la produire. Elle n'expose ni fournisseur,
 * ni modèle, ni seuil, ni contournement, ni reprise — la gouvernance est
 * traversée sans exception : quota, engagement durable, appel unique hors
 * verrou, parseur strict, liaison à l'ensemble soumis, revalidation
 * déterministe, persistance tout-ou-rien.
 *
 * Elle passe par la porte publique, et par elle seule.
 *
 * ## Le contexte est une ENTRÉE, jamais un agrégat
 *
 * ```text
 * --controversy   ctve_  l'entrée d'OUVERTURE de la controverse
 * ```
 *
 * Un `ctv_` n'est pas accepté et n'est **jamais** converti en son entrée
 * d'ouverture : une résolution implicite ferait décider à la CLI ce que
 * l'humain n'a pas nommé.
 *
 * ## Présence ici, forme au domaine
 *
 * La CLI vérifie que les deux arguments sont **présents**, jamais qu'ils sont
 * canoniques — exactement comme `ccr adduce` et `ccr detect`. La forme
 * appartient au domaine, qui la refuse avec un `CcrError`. Prévalider ici ferait
 * qu'un argument mal écrit masquerait un refus de disponibilité, alors que la
 * porte doit être consultée la première.
 */
async function commandAdduceModel(deps: RunServiceDeps, parsed: ParsedArgs, io: CliIo): Promise<number> {
  const materialId = parsed.positionals[0];
  if (materialId === undefined || materialId.length === 0) {
    throw new UsageError('`ccr adduce-model` attend un identifiant de matériau : <material_id>.');
  }

  const opening = parsed.flags.get('controversy');
  if (opening === undefined || opening.length === 0) {
    throw new UsageError(
      "L'option --controversy attend l'identifiant « ctve_ » de l'entrée d'ouverture de la controverse.",
    );
  }

  const target = await resolveRunTarget(deps.runsDir, parsed.flags.get('run'));
  const slot = parsed.flags.get('expert');
  if (slot !== undefined && !isExpertSlotId(slot)) {
    throw new UsageError('`--expert` doit valoir "author" ou "challenger".');
  }

  const outcome = await requestModelAdduction(deps, {
    runId: target.runId,
    material_id: materialId,
    // Transmis LITTÉRALEMENT : aucune réécriture, aucune résolution.
    controversy_opening_entry_id: opening,
    expert_slot: slot ?? 'author',
  });

  if (outcome.kind === 'NOT_AVAILABLE') {
    io.err(`L'adduction assistée par modèle n'est pas disponible sur ce runtime (${outcome.availability}).`);
    return 1;
  }

  const adduction = outcome.adduction;
  io.out(`Run ${target.runId} — matériau ${materialId}, controverse ouverte par ${opening}`);
  io.out(`Invocation ${adduction.invocation_id}`);
  io.out('');

  switch (adduction.kind) {
    case 'PERSISTED':
      io.out(
        `${String(adduction.entries.length)} adduction(s) inférée(s) par CCR, enregistrée(s) : ` +
          adduction.entries.map((entry) => entry.entry_id).join(', '),
      );
      for (const entry of adduction.entries) {
        io.out(`  · ${entry.material_id} ${entry.orientation} ${entry.target.entry_id}`);
      }
      io.out(`Fraîcheur V4 ${adduction.evidence_revision}`);
      io.out('');
      io.out("Une inférence n'est ni une vérité, ni une clôture.");
      return 0;

    case 'VALID_ZERO':
      io.out('Sortie valide, aucune adduction proposée.');
      io.out("Cela ne dit pas que rien n'appuie ni ne contredit la cible.");
      return 0;

    case 'INVALID_OUTPUT':
      io.err(`Sortie de modèle inexploitable (${adduction.reason}, ${adduction.at}).`);
      io.err("L'invocation reste enregistrée. Aucune adduction n'a été écrite, et aucune reprise n'a lieu.");
      return 1;

    case 'REVALIDATION_REFUSED':
      io.err(`Revalidation refusée au contrôle ${adduction.check} (${adduction.at}).`);
      io.err(adduction.detail);
      io.err("L'invocation reste enregistrée. Aucune adduction du lot n'a été écrite.");
      return 1;

    case 'PROVIDER_FAILED':
      io.err(`Le moteur n'a pas rendu de sortie (${adduction.error_code}).`);
      io.err("L'invocation reste enregistrée. Aucune adduction n'a été écrite, et aucune reprise n'a lieu.");
      return 1;
  }
}

/**
 * `ccr detect` — la surface humaine de la détection assistée par modèle.
 *
 * Activée après le verdict PASS du micro-gate REAL, et selon la seule surface
 * que le plan gelé retienne au premier palier : la CLI.
 *
 * ## Ce que cette commande n'est pas
 *
 * Elle n'est **pas** la voie d'acceptation contrôlée du gate : celle-ci reste
 * interne, et aucun argument ne peut la produire. Elle n'expose ni fournisseur,
 * ni modèle, ni seuil, ni contournement — le moteur est celui que le manifest
 * lie à l'expert nommé, et la gouvernance est traversée sans exception.
 *
 * Elle passe par la porte publique, et par elle seule.
 */
async function commandDetect(deps: RunServiceDeps, parsed: ParsedArgs, io: CliIo): Promise<number> {
  // La cible est un expert, en positionnel — comme `send` et `handoff`. Le
  // vocabulaire documenté est fermé : aucun alias de moteur n'est admis ici,
  // parce qu'un alias ambigu ne se résout pas sans le manifest.
  const slot = parsed.positionals[0] ?? '';
  if (!isExpertSlotId(slot)) {
    throw new UsageError('`ccr detect` attend un expert : <author|challenger>.');
  }

  // Un identifiant canonique voyage en option nommée, comme `--run`.
  const controversyId = parsed.flags.get('controversy');
  if (controversyId === undefined || controversyId.length === 0) {
    throw new UsageError("L'option --controversy attend l'identifiant d'une controverse enregistrée.");
  }

  const target = await resolveRunTarget(deps.runsDir, parsed.flags.get('run'));

  // La génération n'est pas revérifiée ici : la frontière de mutation native
  // refuse un run historique avant tout fait durable, et la dupliquer créerait
  // une seconde autorité d'admission.
  const outcome = await requestModelDetection(deps, {
    runId: target.runId,
    controversy_id: controversyId,
    expert_slot: slot,
  });

  if (outcome.kind === 'NOT_AVAILABLE') {
    io.err(`La détection assistée par modèle n'est pas disponible sur ce runtime (${outcome.availability}).`);
    return 1;
  }

  const detection = outcome.detection;
  io.out(`Run ${target.runId} — controverse ${controversyId}, expert ${slot}`);
  io.out(`Invocation ${detection.invocation_id}`);
  io.out('');

  switch (detection.kind) {
    case 'PERSISTED':
      io.out(
        `${String(detection.entries.length)} relation(s) inférée(s) par CCR, enregistrée(s) : ` +
          detection.entries.map((entry) => entry.entry_id).join(', '),
      );
      for (const entry of detection.entries) {
        const relation = entry.relation;
        if (relation !== undefined) {
          io.out(`  · ${relation.from_entry_id} ${relation.act} ${relation.to_entry_id}`);
        }
      }
      io.out('');
      io.out(
        "Une inférence n'est ni une vérité, ni une clôture : elle reste attribuée à CCR, " +
          'et un humain peut la confirmer ou la contester.',
      );
      return 0;

    case 'VALID_ZERO':
      io.out('Sortie valide, aucune relation proposée.');
      io.out(
        "Cela ne dit pas que les experts sont d'accord, ni qu'aucun désaccord n'existe : " +
          "le modèle n'a rien proposé, voilà tout.",
      );
      return 0;

    case 'INVALID_OUTPUT':
      io.err(`Sortie de détection inexploitable (${detection.reason}, ${detection.at}).`);
      io.err("L'invocation reste enregistrée. Aucune relation n'a été écrite, et aucune reprise n'a lieu.");
      return 1;

    case 'PROVIDER_FAILED':
      io.err(`Le moteur n'a pas rendu de sortie (${detection.error_code}).`);
      io.err("L'invocation reste enregistrée. Aucune relation n'a été écrite, et aucune reprise n'a lieu.");
      return 1;
  }
}

async function commandRecover(deps: RunServiceDeps, parsed: ParsedArgs, io: CliIo): Promise<number> {
  const acknowledge = parsed.flags.get('acknowledge');
  const domain = parsed.flags.get('domain');
  const action = parsed.flags.get('action');
  const note = parsed.flags.get('note');
  const target = await resolveRunTarget(deps.runsDir, parsed.flags.get('run'));

  if (target.generation === 'NATIVE_V21_EXECUTION') {
    if (acknowledge !== undefined) {
      throw new UsageError(
        "--acknowledge appartient à la reprise historique. Sur un run natif, l'acquittement " +
          "d'une incertitude se demande par --domain <domaine> --action acknowledge-uncertainty " +
          '--note "…".',
      );
    }
    return await commandNativeRecover(deps, target.runId, { domain, action, note }, io);
  }

  // Aucune option native ne doit être silencieusement ignorée sur un run
  // historique : elle décrirait un geste que ce moteur ne connaît pas.
  for (const [name, value] of [
    ['domain', domain],
    ['action', action],
    ['note', note],
  ] as const) {
    if (value !== undefined) {
      throw new UsageError(
        `--${name} n'existe que pour la reprise d'un run natif. Le run ${target.runId} est ` +
          'historique : utilisez `ccr recover [--acknowledge <note>]`.',
      );
    }
  }

  const result = await recoverRun(deps, {
    runId: target.runId,
    ...(acknowledge === undefined ? {} : { acknowledge }),
  });

  io.out(`Run ${result.runId}`);
  for (const action of result.actions) io.out(`  · ${action}`);

  if (result.ambiguity !== undefined) {
    io.out('');
    io.out('AMBIGUÏTÉ NON RÉSOLUE');
    io.out(`  raison        : ${result.ambiguity.reason}`);
    if (result.ambiguity.operation !== null) {
      const operation = result.ambiguity.operation;
      io.out(`  opération     : ${operation.kind}`);
      io.out(`  agent         : ${operation.agent}`);
      io.out(`  session       : ${operation.session_id ?? '—'}`);
      io.out(`  prompt        : ${operation.prompt_event_id ?? '—'}`);
      io.out(`  source        : ${operation.source_event_id ?? '—'}`);
      io.out(`  engagée le    : ${operation.started_at}`);
    }
    io.out(`  dernier event : ${result.ambiguity.lastEventId ?? '—'}`);
    io.out('');
    io.out("CCR ne peut pas déterminer si le tour a eu lieu, et ne le rejouera pas.");
    io.out('Inspectez la session native, puis acquittez :');
    io.out('  ccr recover --acknowledge "ce que vous avez constaté"');
  }

  io.out('');
  io.out(`État : ${result.state.state} / ${result.state.control}`);
  return 0;
}

/**
 * `ccr recover` sur un run natif.
 *
 * Sans geste nommé, la commande **n'écrit rien** : elle montre les quatre
 * domaines et ce que chacun accepte, et demande une sélection explicite. Aucun
 * geste n'est choisi automatiquement, même lorsqu'un seul est disponible : un
 * acquittement d'incertitude et une clôture avant appel n'affirment pas la même
 * chose, et le choix appartient à l'humain.
 *
 * Avec un geste nommé, la CLI ne vérifie que la **syntaxe** du couple. La
 * disponibilité réelle est réévaluée par la primitive elle-même, sous verrou :
 * un instantané de lecture n'autorise jamais une mutation.
 */
async function commandNativeRecover(
  deps: RunServiceDeps,
  runId: string,
  input: { domain?: string; action?: string; note?: string },
  io: CliIo,
): Promise<number> {
  const readModel = (): Promise<Awaited<ReturnType<typeof buildNativeRunReadModel>>> =>
    buildNativeRunReadModel({ runsDir: deps.runsDir }, runId);

  if (input.domain === undefined && input.action === undefined) {
    io.out(formatNativeRecoveryOverview(await readModel()));
    io.err('');
    io.err(
      'Aucun geste n\'est choisi automatiquement : nommez le domaine et le geste, par exemple ' +
        '`ccr recover --domain send --action finalize`.',
    );
    return 2;
  }
  if (input.domain === undefined || input.action === undefined) {
    throw new UsageError(
      'Une reprise native se nomme entièrement : --domain <' +
        NATIVE_RECOVERY_DOMAINS.join('|') +
        '> ET --action <' +
        Object.keys(NATIVE_RECOVERY_ACTION_SLUGS).join('|') +
        '>.',
    );
  }
  if (!isNativeRecoveryDomain(input.domain)) {
    throw new UsageError(
      `Domaine de reprise inconnu : ${input.domain}. Attendu : ${NATIVE_RECOVERY_DOMAINS.join(', ')}.`,
    );
  }
  const actionId = nativeRecoveryActionOf(input.action);
  if (actionId === undefined) {
    throw new UsageError(
      `Geste de reprise inconnu : ${input.action}. Attendu : ` +
        `${Object.keys(NATIVE_RECOVERY_ACTION_SLUGS).join(', ')}.`,
    );
  }
  if (!isSupportedPair(input.domain, actionId)) {
    // Aucune approximation vers un geste voisin : le couple n'existe pas.
    throw new UsageError(unsupportedPairError(input.domain, actionId).message);
  }
  if (requiresNote(actionId) && (input.note === undefined || input.note.trim().length === 0)) {
    throw new UsageError(
      `--note est obligatoire pour « ${input.action} » : l'acquittement est une affirmation ` +
        'humaine, et CCR n\'en rédige aucune.',
    );
  }
  if (!requiresNote(actionId) && input.note !== undefined) {
    throw new UsageError(
      `--note ne s'applique pas à « ${input.action} » : seuls les acquittements en exigent une. ` +
        `Gestes de ce domaine : ${slugsOf(input.domain).join(', ')}.`,
    );
  }

  const outcome = await runNativeRecovery(deps, runId, input.domain, actionId, input.note);
  // Relecture fraîche : l'état affiché est celui d'après la mutation, produit
  // par la projection, jamais recalculé ici.
  io.out(formatNativeRecoveryResult(await readModel(), outcome.domain, outcome.actions));
  return 0;
}

async function commandStop(deps: RunServiceDeps, parsed: ParsedArgs, io: CliIo): Promise<number> {
  const target = await resolveRunTarget(deps.runsDir, parsed.flags.get('run'));
  if (target.generation === 'NATIVE_V21_EXECUTION') throw deferredNativeCommand('stop', target.runId);

  const result = await stopRun(deps, { runId: target.runId });

  io.out(
    result.changed
      ? `Run ${result.runId} clos. Les sessions natives restent accessibles.`
      : `Run ${result.runId} déjà clos (inchangé).`,
  );
  return 0;
}

/**
 * `ccr setup`.
 *
 * La CLI ne fournit au service que ses moyens d'interaction : l'invite `[y/N]`
 * et la sortie. Toute la décision appartient au service.
 */
async function commandSetup(
  rest: readonly string[],
  io: CliIo,
  injected: Partial<SetupDeps> | undefined,
): Promise<number> {
  const parsedSetup = parseArgs(rest, ['run', 'runs-dir']);
  if (parsedSetup.positionals.length > 0) {
    throw new UsageError('`ccr setup` n' + "'" + 'attend aucun argument positionnel.');
  }

  const runId = parsedSetup.flags.get('run');
  if (runId !== undefined) {
    if (runId.length === 0) throw new UsageError('L' + "'" + 'option --run attend un identifiant de run.');
    return await commandSetupRun(runId, parsedSetup, io, injected);
  }

  const terminal = injected?.io === undefined ? createTerminalPrompt() : undefined;
  try {
    const result = await runSetup({
      ...injected,
      io: injected?.io ?? { out: io.out, confirm: terminal?.confirm ?? (async () => false) },
    });
    return result.status === 'READY' ? 0 : 1;
  } finally {
    terminal?.close();
  }
}

/**
 * `ccr doctor`.
 *
 * Aucune interaction, aucun terminal requis : la commande doit être utilisable
 * en CI et sous redirection.
 */
async function commandDoctor(
  parsed: ParsedArgs,
  io: CliIo,
  injected: DoctorDeps | undefined,
): Promise<number> {
  if (parsed.positionals.length > 1) {
    throw new UsageError('`ccr doctor` accepte au plus un identifiant de run.');
  }
  const runId = parsed.positionals[0];
  const runsDir = parsed.flags.get('runs-dir');

  const report = await runDoctor({
    agentOptions: {
      claude: explicitExecutable('CCR_CLAUDE_BIN'),
      codex: explicitExecutable('CCR_CODEX_BIN'),
    },
    ...(runId === undefined ? {} : { runId }),
    ...(runsDir === undefined ? {} : { runsDir }),
    ...injected,
  });
  io.out(formatDoctorReport(report));
  return report.status === 'BLOCKED' ? 1 : 0;
}

/**
 * Dependances des commandes operant sur un run **existant**.
 *
 * La resolution heritee `env -> config -> defaut` n'est calculee que pour un
 * run depourvu de snapshot (§13.3). Elle est capturee ici puis evaluee
 * paresseusement : un run pinne ne doit dependre de la configuration globale en
 * aucune maniere, pas meme pour echouer si celle-ci est illisible.
 */
async function runCommandDeps(parsed: ParsedArgs): Promise<RunServiceDeps> {
  let resolved:
    | { readonly ok: true; readonly value: boolean }
    | { readonly ok: false; readonly error: unknown };
  try {
    resolved = { ok: true, value: (await loadEffectiveConfig()).codex.skipGitRepoCheck };
  } catch (error) {
    resolved = { ok: false, error };
  }

  return createCliDeps(parsed.flags.get('runs-dir'), {
    legacyCodexSkipGitRepoCheck: (): boolean => {
      if (!resolved.ok) throw resolved.error;
      return resolved.value;
    },
  });
}

/** `ccr setup --run <run_id>` : mutation humaine explicite du snapshot. */
async function commandSetupRun(
  runId: string,
  parsed: ParsedArgs,
  io: CliIo,
  injected: Partial<SetupDeps> | undefined,
): Promise<number> {
  const tty =
    injected?.tty ?? { stdin: process.stdin.isTTY === true, stdout: process.stdout.isTTY === true };
  if (!tty.stdin || !tty.stdout) {
    throw new CcrError(
      'INTERACTIVE_TTY_REQUIRED',
      '`ccr setup --run` est une commande interactive et requiert un terminal. ' +
        "Aucun run n'a ete modifie.",
      { details: { runId, stdinIsTty: tty.stdin, stdoutIsTty: tty.stdout } },
    );
  }

  const runsDir = resolveRunsDir(parsed.flags.get('runs-dir'));
  const loaded = await loadRun(runsDir, runId);
  const snapshot = requirePinnedSnapshot(loaded.manifest);
  const current = snapshot.codex.skip_git_repo_check;

  io.out(`CCR - configuration du run ${runId}`);
  io.out('');
  io.out('Codex hors depot Git');
  io.out(`  Valeur actuelle : ${current ? 'autorise' : 'non autorise'}`);
  io.out('  Cette valeur gouverne les invocations Codex de ce run, quel que soit');
  io.out("  l'etat de la configuration globale ou de l'environnement.");

  const terminal = injected?.io === undefined ? createTerminalPrompt() : undefined;
  try {
    const confirm = injected?.io?.confirm ?? terminal?.confirm;
    // La question porte toujours sur le **changement** : un simple Enter ne
    // peut donc ni activer ni desactiver le reglage.
    const consent =
      confirm === undefined
        ? false
        : await confirm(
            current
              ? "Desactiver l'utilisation de Codex hors depot Git pour ce run ?"
              : "Activer l'utilisation de Codex hors depot Git pour ce run ?",
          );

    if (!consent) {
      io.out('');
      io.out('Aucune modification.');
      return 0;
    }

    const result = await updateRunRuntimeConfig(runsDir, { runId, skipGitRepoCheck: !current });
    io.out('');
    io.out(
      `Configuration runtime modifiee : codex.skip_git_repo_check ${String(result.previous)} -> ` +
        `${String(result.next)} (evenement ${result.eventId}).`,
    );
    io.out("L'automatisation n'a pas ete relancee : `ccr resume` reste une decision explicite.");
    return 0;
  } finally {
    terminal?.close();
  }
}

// --------------------------------------------------------------------------
/**
 * Attend un signal d'arrêt.
 *
 * `SIGINT` et `SIGTERM` sont pris en charge là où la plateforme les délivre
 * réellement. Sous Windows, `process.kill()` est une terminaison
 * inconditionnelle : le gestionnaire n'est pas appelé, le verrou survit, et le
 * démarrage suivant refuse — ce qui est exactement le comportement attendu
 * d'un arrêt brutal (§10). CCR ne construit pas de gestionnaire de démon pour
 * masquer cette différence.
 */
function waitForShutdownSignal(): Promise<string> {
  return new Promise((resolve) => {
    const onSignal = (signal: string): void => {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      resolve(signal);
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  });
}

function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^[0-9]{1,5}$/.test(raw)) throw new UsageError(`Port invalide : ${raw}`);
  const port = Number.parseInt(raw, 10);
  // `0` reste accepté : port éphémère, utile et explicitement demandé.
  if (port > 65535) throw new UsageError(`Port invalide : ${raw}`);
  return port;
}

async function commandCockpit(parsed: ParsedArgs, io: CliIo): Promise<number> {
  const subcommand = parsed.positionals[0];

  if (subcommand === 'clear-stale-lock') {
    const lockId = parsed.flags.get('lock-id');
    if (lockId === undefined || lockId.length === 0) {
      throw new UsageError('`--lock-id <identifiant>` est obligatoire : la levée ne se fonde jamais sur un PID.');
    }
    const { dataRoot, removed } = await clearStaleCockpitLock(parsed.flags.get('runs-dir'), lockId);
    io.out(`Verrou de cockpit levé : instance ${removed.instance_id}`);
    io.out(`  data root : ${dataRoot.dataRoot}`);
    return 0;
  }

  if (subcommand !== undefined) {
    throw new UsageError(`Sous-commande de cockpit inconnue : ${subcommand}`);
  }

  const port = parsePort(parsed.flags.get('port'));
  const instance = await startCockpit({
    ...(parsed.flags.get('runs-dir') === undefined ? {} : { runsDir: parsed.flags.get('runs-dir') }),
    ...(port === undefined ? {} : { port }),
  });

  io.out('CCR Local Cockpit');
  io.out(instance.server.url);
  io.out(`data root : ${instance.dataRoot.dataRoot}`);
  io.out('Ctrl-C pour arrêter.');

  await waitForShutdownSignal();
  const outcome = await instance.stop();
  if (outcome !== 'RELEASED' && outcome !== 'ALREADY_GONE') {
    io.err(`Le verrou de cockpit n'a pas pu être libéré (${outcome}).`);
    return 1;
  }
  return 0;
}

// Point d'entrée
// --------------------------------------------------------------------------

function formatError(error: unknown): string {
  if (isCcrError(error)) {
    const lines = [`Erreur [${error.code}] ${error.message}`];
    for (const [key, value] of Object.entries(error.details)) {
      if (value === null || value === undefined || key === 'command') continue;
      lines.push(`  ${key} : ${typeof value === 'string' ? value : JSON.stringify(value)}`);
    }
    return lines.join('\n');
  }
  return `Erreur inattendue : ${error instanceof Error ? error.message : String(error)}`;
}

export async function runCli(
  argv: readonly string[],
  overrides: { deps?: RunServiceDeps; io?: CliIo; setup?: Partial<SetupDeps>; doctor?: DoctorDeps; preflight?: StartPreflightDeps } = {},
): Promise<number> {
  const io = overrides.io ?? DEFAULT_IO;
  const command = argv[0];

  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    io.out(USAGE);
    return command === undefined ? 2 : 0;
  }

  try {
    const rest = argv.slice(1);
    const commonFlags = ['runs-dir'];

    switch (command) {
      case 'start': {
        const parsed = parseArgs(rest, [
          ...commonFlags,
          'title',
          'cwd',
          'prompt',
          'prompt-file',
          'author-provider',
          'challenger-provider',
          'max-invocations',
          // Compatibilité de syntaxe, dépréciée. Voir `parseStartBindings`.
          'claude-role',
          'codex-role',
        ]);
        return await commandStart(parsed, io, {
          ...(overrides.deps === undefined ? {} : { deps: overrides.deps }),
          ...(overrides.preflight === undefined ? {} : { preflight: overrides.preflight }),
        });
      }
      case 'list': {
        const parsed = parseArgs(rest, commonFlags);
        const deps = overrides.deps ?? (await runCommandDeps(parsed));
        return await commandList(deps, io);
      }
      case 'status': {
        const parsed = parseArgs(rest, commonFlags);
        const deps = overrides.deps ?? (await runCommandDeps(parsed));
        return await commandStatus(deps, parsed, io);
      }
      case 'invocation-outcomes': {
        const parsed = parseArgs(rest, [...commonFlags, 'invocation']);
        const deps = overrides.deps ?? (await runCommandDeps(parsed));
        return await commandInvocationOutcomes(deps, parsed, io);
      }
      case 'send': {
        const parsed = parseArgs(rest, [...commonFlags, 'run', 'file']);
        const deps = overrides.deps ?? (await runCommandDeps(parsed));
        return await commandSend(deps, parsed, io);
      }
      case 'step': {
        const parsed = parseArgs(rest, [...commonFlags, 'run']);
        const deps = overrides.deps ?? (await runCommandDeps(parsed));
        return await commandStep(deps, parsed, io);
      }
      case 'pause': {
        const parsed = parseArgs(rest, [...commonFlags, 'run']);
        const deps = overrides.deps ?? (await runCommandDeps(parsed));
        return await commandPause(deps, parsed, io);
      }
      case 'resume': {
        const parsed = parseArgs(rest, [...commonFlags, 'run']);
        const deps = overrides.deps ?? (await runCommandDeps(parsed));
        return await commandResume(deps, parsed, io);
      }
      case 'handoff': {
        const parsed = parseArgs(rest, [...commonFlags, 'run']);
        const deps = overrides.deps ?? (await runCommandDeps(parsed));
        return await commandHandoff(deps, parsed, io);
      }
      case 'material': {
        const parsed = parseArgs(rest, [...commonFlags, 'run', 'label']);
        const deps = overrides.deps ?? (await runCommandDeps(parsed));
        return await commandMaterial(deps, parsed, io);
      }
      case 'adduce': {
        const parsed = parseArgs(rest, [...commonFlags, 'run', 'target', 'orientation', 'quote', 'occurrence']);
        const deps = overrides.deps ?? (await runCommandDeps(parsed));
        return await commandAdduce(deps, parsed, io);
      }
      case 'adduce-model': {
        const parsed = parseArgs(rest, [...commonFlags, 'run', 'controversy', 'expert']);
        const deps = overrides.deps ?? (await runCommandDeps(parsed));
        return await commandAdduceModel(deps, parsed, io);
      }
      case 'detect': {
        const parsed = parseArgs(rest, [...commonFlags, 'run', 'controversy']);
        const deps = overrides.deps ?? (await runCommandDeps(parsed));
        return await commandDetect(deps, parsed, io);
      }
      case 'decide': {
        const parsed = parseArgs(rest, [...commonFlags, 'run', 'file']);
        const deps = overrides.deps ?? (await runCommandDeps(parsed));
        return await commandDecide(deps, parsed, io);
      }
      case 'recover': {
        const parsed = parseArgs(rest, [...commonFlags, 'run', 'acknowledge', 'domain', 'action', 'note']);
        const deps = overrides.deps ?? (await runCommandDeps(parsed));
        return await commandRecover(deps, parsed, io);
      }
      case 'stop': {
        const parsed = parseArgs(rest, [...commonFlags, 'run']);
        const deps = overrides.deps ?? (await runCommandDeps(parsed));
        return await commandStop(deps, parsed, io);
      }
      // --- V5. Le routage n'ajoute aucune règle : il fixe l'allowlist de
      // drapeaux de chaque commande et remet la requête à son propriétaire.
      case 'reconcile': {
        const parsed = parseArgs(rest, [...commonFlags, ...RECONCILE_FLAGS]);
        const deps = overrides.deps ?? (await runCommandDeps(parsed));
        return await commandReconcile(deps, parsed, io);
      }
      case 'respond': {
        const parsed = parseArgs(rest, [...commonFlags, ...RESPOND_FLAGS]);
        const deps = overrides.deps ?? (await runCommandDeps(parsed));
        return await commandRespond(deps, parsed, io);
      }
      case 'reconciliation': {
        const parsed = parseArgs(rest, [...commonFlags, ...RECONCILIATION_READ_FLAGS]);
        const deps = overrides.deps ?? (await runCommandDeps(parsed));
        return await commandReconciliationRead(deps, parsed, io);
      }
      case 'propose': {
        const parsed = parseArgs(rest, [...commonFlags, ...PROPOSE_FLAGS]);
        const deps = overrides.deps ?? (await runCommandDeps(parsed));
        return await commandPropose(deps, parsed, io);
      }
      case 'setup':
        return await commandSetup(rest, io, overrides.setup);
      case 'cockpit': {
        const parsed = parseArgs(rest, [...commonFlags, 'port', 'lock-id']);
        return await commandCockpit(parsed, io);
      }
      case 'doctor':
        return await commandDoctor(parseArgs(rest, ['runs-dir']), io, overrides.doctor);
      default:
        io.err(`Commande inconnue : ${command}`);
        io.err('');
        io.err(USAGE);
        return 2;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(error.message);
      io.err('');
      io.err(USAGE);
      return 2;
    }
    io.err(formatError(error));
    if (isCcrError(error) && error.code === 'INTERACTIVE_TTY_REQUIRED') {
      // Contexte d'exécution inadapté, non erreur de traitement (§22.1).
      return 2;
    }
    if (isCcrError(error) && error.code === 'RECOVERY_REQUIRED') {
      io.err('');
      io.err('Utilisez `ccr status` pour examiner la situation avant toute reprise.');
    }
    return 1;
  }
}

export { CcrError };
