/**
 * Store d'idempotence durable — infrastructure de **transport**, jamais de
 * métier (V0.2 §19 ; amendement V2-IMP-37).
 *
 * ## Ce qu'il garantit
 *
 * ```text
 * même clé + même empreinte   → au plus un effet, le même reçu
 * même clé + autre empreinte  → refus, aucun effet
 * crash après le claim        → UNKNOWN, jamais un rejeu
 * reçu illisible              → refus explicite, jamais « donc absent »
 * ```
 *
 * ## Ce qu'il n'est pas
 *
 * Il ne participe à aucune vérité CCR. Il n'entre pas dans la révision, ne
 * produit aucun événement, ne modifie aucun fichier canonique, et sa
 * disparition ne changerait aucun état de run — elle ne ferait que perdre la
 * protection contre le rejeu. Les statuts ci-dessous décrivent l'exécution
 * d'une requête HTTP, pas l'état d'un run.
 *
 * ## Disposition physique — et pourquoi celle-ci
 *
 * ```text
 * <ccr-data-root>/cockpit/operations/<2 hex>/<digest 64 hex>.json
 * operation_id = op_<digest 64 hex>
 * digest       = sha256(Idempotency-Key)
 * ```
 *
 * Trois conséquences recherchées :
 *
 * 1. **la clé brute n'est jamais persistée** — seul son condensat l'est, ce qui
 *    suffit à reconnaître une retransmission ;
 * 2. **aucun scan** : la clé donne le chemin, et `operation_id` aussi, puisque
 *    l'un dérive de l'autre. Ni index secondaire à maintenir, ni parcours de
 *    répertoire sur le chemin nominal ;
 * 3. **le claim est le fichier** : `open(…, 'wx')` est une création exclusive
 *    atomique, la même primitive que les verrous. Deux requêtes concurrentes ne
 *    peuvent pas gagner ensemble, et cela se vérifie physiquement.
 *
 * Le préfixe de deux caractères borne le nombre d'entrées par répertoire ; il
 * n'est pas une optimisation de lecture, qui n'en a pas besoin.
 *
 * ## Créer n'est pas publier (amendement V2-IMP-41)
 *
 * `open(…, 'wx')` établit la propriété, mais crée le fichier **vide** : le reçu
 * n'y est écrit qu'ensuite. Pendant cette fenêtre, le chemin de la clé existe
 * et ne contient rien. La première écriture de ce store lisait ce chemin dès
 * l'`EEXIST` — et concluait à la corruption d'un fichier que son propriétaire
 * vivant était simplement en train de publier.
 *
 * C'était un bug, démontré et reproduit. Le fichier n'était pas corrompu ; la
 * lecture était prématurée.
 *
 * La correction ne change ni le format, ni la disposition, ni la primitive
 * d'exclusion. Elle ajoute un **ordonnancement par clé** : dans ce processus,
 * au plus une tentative de claim est en vol pour un chemin donné, et les
 * suivantes attendent que la précédente ait fini de publier. Trois situations
 * deviennent alors distinguables, ce qu'un seul coup d'œil au disque ne
 * permettait pas :
 *
 * ```text
 * publication locale en cours    → la file d'attente ; jamais une lecture
 * reçu durable déjà publié       → lecture normale, document complet
 * artefact incomplet après crash → aucune publication en vol, fichier illisible
 *                                  → corruption explicite, jamais un reclaim
 * ```
 *
 * La troisième reste **fail-closed** : un artefact incomplet trouvé au
 * démarrage n'est ni supprimé, ni réclamé, ni traité comme absent. Le supprimer
 * pour repartir à neuf autoriserait précisément le rejeu que ce store existe
 * pour interdire.
 *
 * ### Portée de l'ordonnancement
 *
 * La file est **intra-processus**, et c'est suffisant parce que le store l'est
 * aussi : `server.lock` garantit un seul cockpit par racine de données, et le
 * store d'opérations est créé une fois par cockpit, dans le répertoire même où
 * ce verrou est posé. Deux processus ne peuvent donc pas publier
 * concurremment sous la même racine. Cette garantie vient d'ailleurs, elle est
 * nommée ici pour que la limite soit lisible plutôt que supposée.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';

import { CcrError } from '../core/errors.ts';
import { writeJsonAtomic } from '../store/atomic-file.ts';
import type { CockpitDataRoot } from './data-root.ts';

export const OPERATION_RECEIPT_SCHEMA_VERSION = 1;
export const OPERATIONS_DIR_NAME = 'operations';

/**
 * Statut d'exécution d'une requête mutante. **Pas** une machine d'état métier.
 *
 * `UNKNOWN` est le verdict honnête d'un arrêt brutal : CCR ne sait pas si
 * l'effet a eu lieu, et ne le devinera pas depuis les événements.
 */
export type OperationStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';

/**
 * Issue **métier**, distincte du statut d'exécution.
 *
 * ```text
 * status          ce que le transport a fait de la requête
 * domain_outcome  ce que le domaine propriétaire a répondu
 * ```
 *
 * Les deux coexistent sans se contredire : une opération peut s'exécuter
 * entièrement — `SUCCEEDED` — et rendre une issue de refus. Confondre les deux
 * fait dire « effectuée » à un reçu qui n'a rien enregistré, ce que le run réel
 * `CCR-20260404-001` a montré.
 *
 * Le vocabulaire est **opaque pour le store** : celui-ci transporte une chaîne
 * qu'il ne sait pas interpréter. L'union fermée appartient au module
 * propriétaire, et c'est lui qui garantit son exhaustivité — le transport ne
 * doit pas devenir une seconde autorité sur le sens des issues.
 */
export interface OperationDomainOutcome {
  /** Nom de l'issue, dans le vocabulaire du domaine. Jamais vide. */
  readonly outcome: string;
  /** Cause nommée, lorsque le domaine en fournit une. */
  readonly reason?: string;
  /** Diagnostic public — position, détail de contrôle. */
  readonly detail?: string;
  /** Engagement durable correspondant, lorsqu'il en existe un. */
  readonly invocation_id?: string;
}

export interface OperationReceipt {
  readonly schema_version: number;
  readonly operation_id: string;
  /** Instance de serveur qui a posé le claim. Sert à détecter un redémarrage. */
  readonly server_instance_id: string;
  /**
   * Run **visé**, lorsqu'il existe déjà.
   *
   * Absent pour `START` : au moment du claim, aucun run n'existe encore — c'est
   * même la raison d'être du claim, qui doit précéder l'allocation.
   */
  readonly run_id?: string;
  /**
   * Run **créé** par cette opération, lorsqu'il y en a un.
   *
   * Écrit une seule fois, avant le premier appel fournisseur, et **immuable**
   * ensuite : un même `operation_id` ne peut pas désigner successivement deux
   * runs. C'est ce qui permet à un client ayant perdu sa réponse de retrouver
   * ce que son intention a produit.
   */
  readonly created_run_id?: string;
  readonly action: string;
  readonly fingerprint: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly status: OperationStatus;
  readonly error_code?: string;
  readonly revision_after?: string;
  /**
   * Issue métier, lorsque l'opération en a produit une.
   *
   * Absente n'est **pas** synonyme de succès : un reçu antérieur à ce champ,
   * ou une opération dont le domaine ne rend pas d'issue nommée, n'en porte
   * pas. Le lecteur ne doit donc rien en déduire par défaut.
   */
  readonly domain_outcome?: OperationDomainOutcome;
}

/** Projection remise au navigateur. Ni empreinte, ni instance, ni chemin. */
export interface PublicOperationReceipt {
  readonly operation_id: string;
  readonly run_id?: string;
  readonly created_run_id?: string;
  readonly action: string;
  readonly status: OperationStatus;
  readonly created_at: string;
  readonly updated_at: string;
  readonly error_code?: string;
  readonly revision_after?: string;
  readonly domain_outcome?: OperationDomainOutcome;
}

export function toPublicReceipt(receipt: OperationReceipt): PublicOperationReceipt {
  return {
    operation_id: receipt.operation_id,
    ...(receipt.run_id === undefined ? {} : { run_id: receipt.run_id }),
    ...(receipt.created_run_id === undefined ? {} : { created_run_id: receipt.created_run_id }),
    action: receipt.action,
    status: receipt.status,
    created_at: receipt.created_at,
    updated_at: receipt.updated_at,
    ...(receipt.error_code === undefined ? {} : { error_code: receipt.error_code }),
    ...(receipt.revision_after === undefined ? {} : { revision_after: receipt.revision_after }),
    // L'issue métier traverse la projection **sans réécriture** : le navigateur
    // doit pouvoir distinguer `VALID_ZERO` de `INVALID_OUTPUT`, ce qu'aucun
    // statut d'exécution ne permet.
    ...(receipt.domain_outcome === undefined ? {} : { domain_outcome: receipt.domain_outcome }),
  };
}

const OPERATION_ID_PATTERN = /^op_[0-9a-f]{64}$/;

export function isOperationId(value: string): boolean {
  return OPERATION_ID_PATTERN.test(value);
}

function digestOfKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/**
 * Empreinte d'intention.
 *
 * Construite à partir des **champs validés**, jamais des octets HTTP : deux
 * corps JSON sémantiquement identiques mais aux propriétés ordonnées
 * différemment produisent donc la même empreinte par construction, sans qu'un
 * tri ait à y pourvoir.
 *
 * Pour `DECIDE`, seul le condensat du texte entre dans l'empreinte : reconnaître
 * une retransmission n'exige pas de conserver la décision en clair hors du
 * journal canonique.
 */
export function computeFingerprint(input: {
  readonly method: string;
  /**
   * Intention **logique** — PAUSE, RESUME, DECIDE, STOP.
   *
   * Volontairement l action et non le chemin HTTP : une route est une syntaxe,
   * l action est ce que l humain a voulu. Si la surface HTTP evoluait, deux
   * ecritures de la meme intention ne doivent pas produire deux empreintes.
   */
  readonly action: string;
  /** Absent pour `START` : aucun run n'existe encore. */
  readonly runId?: string;
  /** Absent pour `START` : aucune vue ne peut etre perimee (V0.2 §11.3b). */
  readonly expectedRevision?: string;
  readonly contentDigest?: string;
}): string {
  const canonical = [
    input.method,
    input.action,
    input.runId ?? '',
    input.expectedRevision ?? '',
    input.contentDigest ?? '',
  ].join(' ');
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

export function digestOfContent(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

function parseReceipt(raw: string, file: string): OperationReceipt {
  // Un fichier vide au chemin d'une clé a une cause précise : une publication
  // interrompue. La nommer évite de la confondre avec un document malformé, et
  // ne change rien au verdict — qui reste fail-closed.
  if (raw.trim().length === 0) throw corruption(file, 'reçu vide — publication interrompue');

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw corruption(file, 'JSON illisible', cause);
  }
  if (typeof value !== 'object' || value === null) throw corruption(file, 'document inattendu');

  const candidate = value as Record<string, unknown>;
  const strings = ['operation_id', 'server_instance_id', 'action', 'fingerprint', 'created_at', 'updated_at', 'status'];
  for (const field of strings) {
    if (typeof candidate[field] !== 'string' || (candidate[field] as string).length === 0) {
      throw corruption(file, `champ « ${field} » absent ou invalide`);
    }
  }
  // Conditionnels — mais présents implique renseignés. Une chaîne vide serait
  // une association silencieusement perdue, pas une absence d'association.
  for (const field of ['run_id', 'created_run_id']) {
    const value = candidate[field];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length === 0) {
      throw corruption(file, `champ « ${field} » présent mais vide`);
    }
  }
  // L'issue métier est facultative et **additive** : un reçu écrit avant son
  // introduction reste lisible sous la même version de schéma. Présente, elle
  // doit être nommée — une issue vide serait un verdict perdu, pas une absence.
  const domain = candidate['domain_outcome'];
  if (domain !== undefined) {
    if (typeof domain !== 'object' || domain === null || Array.isArray(domain)) {
      throw corruption(file, 'issue métier illisible');
    }
    const outcome = (domain as Record<string, unknown>)['outcome'];
    if (typeof outcome !== 'string' || outcome.length === 0) {
      throw corruption(file, 'issue métier sans nom');
    }
  }
  if (candidate['schema_version'] !== OPERATION_RECEIPT_SCHEMA_VERSION) {
    throw corruption(file, 'version de schéma inconnue');
  }
  const status = candidate['status'] as string;
  if (!['RUNNING', 'SUCCEEDED', 'FAILED', 'UNKNOWN'].includes(status)) {
    throw corruption(file, `statut inconnu : ${status}`);
  }
  if (!isOperationId(candidate['operation_id'] as string)) {
    throw corruption(file, 'identifiant d’opération incohérent');
  }
  return candidate as unknown as OperationReceipt;
}

/**
 * Une corruption du store d'idempotence est **fail-closed**.
 *
 * La traiter comme une absence rouvrirait exactement le trou que ce store
 * ferme : une retransmission produirait un second effet. Mieux vaut refuser.
 */
function corruption(file: string, reason: string, cause?: unknown): CcrError {
  return new CcrError(
    'OPERATION_STORE_CORRUPT',
    `Le reçu d'idempotence est illisible (${reason}). Aucune opération n'est rejouée.`,
    { details: { path: file, reason }, ...(cause === undefined ? {} : { cause }) },
  );
}

export interface ClaimInput {
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  /** Absent pour `START`, qui réclame sa clé avant que le run existe. */
  readonly runId?: string;
  readonly action: string;
}

export interface ClaimResult {
  /** `CLAIMED` : ce processus détient l'opération et doit produire l'effet. */
  readonly kind: 'CLAIMED' | 'EXISTING';
  readonly receipt: OperationReceipt;
}

export interface OperationStore {
  claim(input: ClaimInput): Promise<ClaimResult>;
  /**
   * Associe durablement le run créé, **sans** terminaliser le reçu.
   *
   * Appelée entre l'allocation et le premier appel fournisseur. C'est ce qui
   * permet, après une réponse HTTP perdue ou un arrêt brutal, de savoir ce que
   * l'intention a produit — sans jamais avoir à deviner en parcourant les runs.
   */
  associateRun(operationId: string, runId: string): Promise<OperationReceipt>;
  settle(operationId: string, patch: SettlePatch): Promise<OperationReceipt>;
  read(operationId: string): Promise<OperationReceipt | undefined>;
}

/**
 * Coutures de publication — **tests uniquement**.
 *
 * `onPublishing` est appelée à l'instant exact où la propriété exclusive est
 * acquise et où le reçu n'est pas encore écrit. C'est la fenêtre que le bug
 * exposait ; la maintenir ouverte à volonté est ce qui rend sa fermeture
 * démontrable au lieu d'être plausible.
 */
export interface OperationStoreSeams {
  readonly onPublishing?: (operationId: string) => void | Promise<void>;
  /**
   * Appelée lorsqu'un claim trouve une publication déjà en vol pour sa clé et
   * doit attendre son tour.
   *
   * C'est la contrepartie observable de `onPublishing` : sans elle, un test ne
   * pourrait distinguer « le concurrent attend » de « le concurrent n'a pas
   * encore commencé », et une correction retirée passerait pour intacte.
   */
  readonly onWaitingForPublication?: (file: string) => void;
  /**
   * Appelée lorsque le tour est **obtenu**, après l'attente s'il y en a eu une.
   *
   * `onWaitingForPublication` dit qu'un claim a l'intention d'attendre ;
   * celle-ci dit qu'il a fini d'attendre. Les deux sont nécessaires : sans la
   * seconde, retirer le seul `await` laisserait les tests verts, puisque
   * l'intention d'attendre serait toujours signalée alors que plus rien
   * n'attendrait.
   */
  readonly onTurnGranted?: (file: string) => void;
}

/**
 * Publications en vol, par chemin de reçu.
 *
 * Volontairement au niveau du module et non de l'instance : deux stores
 * construits sur une même racine dans un même processus — ce que font certains
 * tests — doivent partager la file, sans quoi la fenêtre resterait ouverte
 * entre eux. La clé est le chemin absolu, donc deux racines ne se croisent
 * jamais. Une entrée disparaît dès que sa publication est finie ; la table
 * reste de la taille du parallélisme instantané, pas de l'historique.
 */
const publications = new Map<string, Promise<void>>();

/** Nombre de publications actuellement en vol — diagnostic de test. */
export function inFlightPublications(): number {
  return publications.size;
}

/**
 * Sérialise les tentatives de claim portant le même chemin.
 *
 * L'inscription dans la table précède l'attente : un troisième appelant
 * s'enchaîne derrière nous, et non derrière celui que nous attendons. L'ordre
 * d'arrivée est donc préservé, et à aucun instant deux corps ne s'exécutent
 * ensemble pour une même clé.
 */
async function withPublicationTurn<T>(
  file: string,
  body: () => Promise<T>,
  onWaiting?: (file: string) => void,
  onGranted?: (file: string) => void,
): Promise<T> {
  const previous = publications.get(file);
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  publications.set(file, mine);

  // `previous` ne rejette jamais : il n'est résolu que par son propre `finally`.
  if (previous !== undefined) {
    onWaiting?.(file);
    await previous;
  }
  onGranted?.(file);

  try {
    return await body();
  } finally {
    release();
    if (publications.get(file) === mine) publications.delete(file);
  }
}

export interface SettlePatch {
  readonly status: Exclude<OperationStatus, 'RUNNING'>;
  readonly errorCode?: string;
  readonly revisionAfter?: string;
  /**
   * Issue métier rendue par le domaine. Facultative — beaucoup d'opérations
   * n'en produisent pas, et une absence ne doit jamais être lue comme un
   * succès.
   */
  readonly domain?: OperationDomainOutcome;
}

/**
 * Statut **dérivé** à la lecture.
 *
 * Un reçu resté `RUNNING` alors qu'il appartient à une instance précédente
 * décrit une opération interrompue par un arrêt brutal : on ne sait pas si
 * l'effet a eu lieu. La dérivation se fait en lecture, sans écriture et sans
 * parcours du store — donc sans coût au démarrage, et sans jamais rejouer.
 */
export function deriveStatus(receipt: OperationReceipt, currentInstanceId: string): OperationReceipt {
  if (receipt.status !== 'RUNNING') return receipt;
  if (receipt.server_instance_id === currentInstanceId) return receipt;
  return { ...receipt, status: 'UNKNOWN' };
}

export function createOperationStore(
  dataRoot: CockpitDataRoot,
  serverInstanceId: string,
  now: () => Date = () => new Date(),
  seams: OperationStoreSeams = {},
): OperationStore {
  const root = path.join(dataRoot.controlDir, OPERATIONS_DIR_NAME);

  const fileFor = (digest: string): string => path.join(root, digest.slice(0, 2), `${digest}.json`);

  async function readAt(file: string): Promise<OperationReceipt | undefined> {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      // Présent mais illisible : jamais confondu avec une absence.
      throw corruption(file, `lecture impossible (${(error as NodeJS.ErrnoException).code ?? 'inconnu'})`, error);
    }
    return deriveStatus(parseReceipt(raw, file), serverInstanceId);
  }

  /**
   * Corps du claim, exécuté seul pour une clé donnée.
   *
   * L'ordre importe : la création exclusive **précède** toute écriture, et la
   * publication est terminée — écrite et `fsync`ée — avant que la fonction
   * rende la main. Un appelant qui reçoit `CLAIMED` détient donc une propriété
   * déjà durable, ce qui est la condition pour qu'un effet puisse commencer.
   */
  async function claimExclusively(file: string, digest: string, input: ClaimInput): Promise<ClaimResult> {
    const receipt: OperationReceipt = {
      schema_version: OPERATION_RECEIPT_SCHEMA_VERSION,
      operation_id: `op_${digest}`,
      server_instance_id: serverInstanceId,
      ...(input.runId === undefined ? {} : { run_id: input.runId }),
      action: input.action,
      fingerprint: input.fingerprint,
      created_at: now().toISOString(),
      updated_at: now().toISOString(),
      status: 'RUNNING',
    };

    let handle;
    try {
      // Création exclusive : c'est le claim lui-même, physiquement atomique.
      handle = await open(file, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Le fichier préexiste, et aucune publication locale n'est en vol : ce
      // qu'on lit est soit un reçu complet, soit un artefact de crash.
      const existing = await readAt(file);
      if (existing === undefined) throw corruption(file, 'claim disparu entre création et lecture');
      if (existing.fingerprint !== input.fingerprint) {
        throw new CcrError(
          'IDEMPOTENCY_KEY_REUSED',
          "Cette clé d'idempotence a déjà servi pour une autre opération. Aucune action n'a été effectuée.",
          { details: { operation_id: existing.operation_id } },
        );
      }
      return { kind: 'EXISTING', receipt: existing };
    }

    try {
      // Propriété acquise, reçu pas encore écrit : la fenêtre historique.
      await seams.onPublishing?.(receipt.operation_id);
      await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
      // Durable avant tout effet : un claim perdu au crash autoriserait un rejeu.
      await handle.sync();
    } finally {
      await handle.close();
    }
    return { kind: 'CLAIMED', receipt };
  }

  return {
    async claim(input: ClaimInput): Promise<ClaimResult> {
      const digest = digestOfKey(input.idempotencyKey);
      const file = fileFor(digest);
      await mkdir(path.dirname(file), { recursive: true });
      // Tout ce qui suit s'exécute seul pour cette clé : ce que le disque
      // montre ici est un état stable, jamais une publication à mi-chemin.
      return withPublicationTurn(
        file,
        () => claimExclusively(file, digest, input),
        seams.onWaitingForPublication,
        seams.onTurnGranted,
      );
    },
    async associateRun(operationId: string, runId: string): Promise<OperationReceipt> {
      if (!isOperationId(operationId)) {
        throw new CcrError('INVALID_ARGUMENT', "Identifiant d'opération invalide.");
      }
      const file = fileFor(operationId.slice(3));
      const existing = await readAt(file);
      if (existing === undefined) throw corruption(file, 'reçu absent au moment de son association');

      // Immuable. Réassocier serait pire qu'échouer : le reçu cesserait de
      // désigner ce que l'opération a réellement créé, et deux runs se
      // partageraient une identité d'intention. On refuse, sans corriger.
      if (existing.created_run_id !== undefined && existing.created_run_id !== runId) {
        throw corruption(
          file,
          `run déjà associé (${existing.created_run_id}), réassociation refusée vers ${runId}`,
        );
      }
      if (existing.created_run_id === runId) return existing;

      const associated: OperationReceipt = {
        ...existing,
        created_run_id: runId,
        updated_at: now().toISOString(),
      };
      await writeJsonAtomic(file, associated);
      return associated;
    },

    async settle(operationId: string, patch: SettlePatch): Promise<OperationReceipt> {
      if (!isOperationId(operationId)) {
        throw new CcrError('INVALID_ARGUMENT', "Identifiant d'opération invalide.");
      }
      const file = fileFor(operationId.slice(3));
      const existing = await readAt(file);
      if (existing === undefined) throw corruption(file, 'reçu absent au moment de sa finalisation');

      const settled: OperationReceipt = {
        ...existing,
        status: patch.status,
        updated_at: now().toISOString(),
        ...(patch.errorCode === undefined ? {} : { error_code: patch.errorCode }),
        ...(patch.revisionAfter === undefined ? {} : { revision_after: patch.revisionAfter }),
        ...(patch.domain === undefined ? {} : { domain_outcome: patch.domain }),
      };
      await writeJsonAtomic(file, settled);
      return settled;
    },

    read(operationId: string): Promise<OperationReceipt | undefined> {
      if (!isOperationId(operationId)) {
        return Promise.reject(new CcrError('INVALID_ARGUMENT', "Identifiant d'opération invalide."));
      }
      // L'identifiant est validé avant de toucher au système de fichiers, et le
      // chemin est reconstruit — jamais concaténé depuis l'URL.
      return readAt(fileFor(operationId.slice(3)));
    },
  };
}

/** Identité d'instance, régénérée à chaque démarrage du serveur cockpit. */
export function newServerInstanceId(): string {
  return randomUUID();
}
