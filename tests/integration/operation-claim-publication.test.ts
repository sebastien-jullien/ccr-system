/**
 * Publication du claim durable — réparation d'un bug démontré (V2-IMP-41).
 *
 * Ce qui a été prouvé défaillant, puis corrigé, tient en une phrase : créer le
 * fichier d'une clé n'est pas y publier le reçu. Entre `open(…, 'wx')` et
 * l'écriture, le chemin existait et ne contenait rien — et un concurrent y
 * lisait une corruption là où un propriétaire vivant était en train d'écrire.
 *
 * Les tests ci-dessous ne comptent pas sur la chance : ils ouvrent la fenêtre
 * *exactement* où elle se trouvait, la maintiennent ouverte aussi longtemps
 * qu'ils veulent, et observent ce qu'un concurrent obtient pendant ce temps.
 * Aucune assertion ne repose sur un délai qui « devrait suffire ».
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { resolveCockpitDataRoot } from '../../src/cockpit/data-root.ts';
import {
  createOperationStore,
  inFlightPublications,
  OPERATIONS_DIR_NAME,
} from '../../src/cockpit/operations-store.ts';
import type { ClaimResult, OperationStore, OperationStoreSeams } from '../../src/cockpit/operations-store.ts';
import { isCcrError } from '../../src/core/errors.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';
import type { CockpitDataRoot } from '../../src/cockpit/data-root.ts';

const KEY = 'cle-publication-01';
const FP1 = `sha256:${'1'.repeat(64)}`;
const FP2 = `sha256:${'2'.repeat(64)}`;
const OPERATION_ID = `op_${createHash('sha256').update(KEY, 'utf8').digest('hex')}`;

interface Box {
  readonly dataRoot: CockpitDataRoot;
  readonly receiptPath: string;
  store(instance?: string, seams?: OperationStoreSeams): OperationStore;
  cleanup(): Promise<void>;
}

async function box(): Promise<Box> {
  const dir = await makeTempDir('ccr-claim-publication-');
  const runsDir = path.join(dir, 'runs');
  await mkdir(runsDir, { recursive: true });
  const dataRoot = resolveCockpitDataRoot(runsDir);
  await mkdir(dataRoot.controlDir, { recursive: true });
  const digest = OPERATION_ID.slice(3);
  return {
    dataRoot,
    receiptPath: path.join(dataRoot.controlDir, OPERATIONS_DIR_NAME, digest.slice(0, 2), `${digest}.json`),
    store: (instance = 'instance-1', seams = {}) => createOperationStore(dataRoot, instance, () => new Date(), seams),
    cleanup: () => removeTempDir(dir),
  };
}

/** Une porte que le test ouvre quand il le décide — jamais un délai. */
function gate(): { promise: Promise<void>; open(): void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/**
 * Course entre « le concurrent a signalé qu'il attend » et « le concurrent a
 * tranché ».
 *
 * C'est l'observation qui rend ces tests déterministes plutôt que chanceux. Une
 * première écriture se contentait de regarder si la promesse rivale avait
 * tranché après quelques tours de boucle — et concluait « elle attend » alors
 * que ses opérations de fichier n'étaient simplement pas encore revenues du
 * pool de threads. La preuve tenait au fait que le test était plus rapide que
 * le disque, ce qui ne prouve rien.
 *
 * Ici, le propriétaire n'est libéré qu'après le verdict de cette course. Sans
 * file d'attente, le rival lit forcément le fichier vide — le propriétaire est
 * bloqué — donc il rejette, et la course le dit.
 */
async function firstOf<T>(
  waiting: Promise<void>,
  rival: Promise<T>,
): Promise<'ATTEND' | 'RÉSOLU' | 'REJETÉ'> {
  return Promise.race([
    waiting.then(() => 'ATTEND' as const),
    rival.then(() => 'RÉSOLU' as const, () => 'REJETÉ' as const),
  ]);
}

/** Signal à un coup, armé avant l'action qu'il observe. */
function signal(): { promise: Promise<void>; fire(): void } {
  let fire!: () => void;
  const promise = new Promise<void>((resolve) => {
    fire = resolve;
  });
  return { promise, fire };
}

const codeOf = (error: unknown): string => (isCcrError(error) ? error.code : `non-CCR:${String(error)}`);

// --------------------------------------------------------------------------
// D1 — course déterministe, même clé, même empreinte
// --------------------------------------------------------------------------

test('(D1) concurrent pendant la publication : jamais de corruption, jamais un second propriétaire', async (t) => {
  const b = await box();
  try {
    const held = gate();
    let ownerReachedWindow!: () => void;
    const windowOpen = new Promise<void>((resolve) => {
      ownerReachedWindow = resolve;
    });

    const queued = signal();
    // Le tour du rival lui est-il accordé avant ou après la libération ?
    // Signaler l'intention d'attendre ne suffit pas : retirer le seul `await`
    // la laisserait intacte alors que plus rien n'attendrait.
    let ownerReleased = false;
    // Un tour par appelant, dans l'ordre : le propriétaire d'abord — le sien
    // lui est accordé sans attente — puis le rival.
    const grants: boolean[] = [];
    const store = b.store('instance-1', {
      onPublishing: async () => {
        ownerReachedWindow();
        await held.promise;
      },
      onWaitingForPublication: () => queued.fire(),
      onTurnGranted: () => grants.push(ownerReleased),
    });

    const owner = store.claim({ idempotencyKey: KEY, fingerprint: FP1, action: 'PAUSE', runId: 'CCR-20260402-001' });
    await windowOpen;

    // La fenêtre historique est ouverte, et se constate physiquement.
    const raw = await readFile(b.receiptPath, 'utf8');
    t.diagnostic(`fenêtre ouverte : fichier présent, ${String(raw.length)} octet(s) · publications en vol = ${String(inFlightPublications())}`);
    assert.equal(raw.length, 0, 'la fenêtre testée est bien celle du fichier vide');

    const rival = store.claim({ idempotencyKey: KEY, fingerprint: FP1, action: 'PAUSE', runId: 'CCR-20260402-001' });
    const during = await firstOf(queued.promise, rival);
    t.diagnostic(`concurrent pendant la fenêtre → ${during}`);
    // Il attend son tour. Il ne lit pas, donc il ne peut pas se tromper.
    assert.equal(during, 'ATTEND', 'le concurrent a tranché alors que rien n’était publié');

    ownerReleased = true;
    held.open();
    const first = await owner;
    const second = await rival;
    t.diagnostic(`tours accordés, après libération : ${JSON.stringify(grants)}`);
    assert.deepEqual(grants, [false, true], 'le tour du rival a été accordé alors que la publication durait encore');
    t.diagnostic(`propriétaire=${first.kind} · concurrent=${second.kind} · même op=${String(first.receipt.operation_id === second.receipt.operation_id)}`);

    assert.equal(first.kind, 'CLAIMED');
    assert.equal(second.kind, 'EXISTING', 'un second propriétaire aurait produit un second effet');
    assert.equal(second.receipt.operation_id, first.receipt.operation_id);
    assert.equal(second.receipt.status, 'RUNNING');
    assert.equal(second.receipt.fingerprint, FP1);
    assert.equal(inFlightPublications(), 0, 'la file se vide');
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// D2 — même fenêtre, empreinte différente
// --------------------------------------------------------------------------

test('(D2) même clé, autre empreinte pendant la publication : réutilisation, jamais corruption', async (t) => {
  const b = await box();
  try {
    const held = gate();
    let reached!: () => void;
    const windowOpen = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const queued = signal();
    const store = b.store('instance-1', {
      onPublishing: async () => {
        reached();
        await held.promise;
      },
      onWaitingForPublication: () => queued.fire(),
    });

    const owner = store.claim({ idempotencyKey: KEY, fingerprint: FP1, action: 'PAUSE', runId: 'CCR-20260402-001' });
    await windowOpen;

    const rival = store.claim({ idempotencyKey: KEY, fingerprint: FP2, action: 'STOP', runId: 'CCR-20260402-001' });
    const during = await firstOf(queued.promise, rival);
    t.diagnostic(`empreinte différente pendant la fenêtre → ${during}`);
    assert.equal(during, 'ATTEND', 'aucun verdict avant que l’identité soit déterminable');

    held.open();
    await owner;

    const error = await rival.then(() => undefined, (e: unknown) => e);
    t.diagnostic(`empreinte différente → ${codeOf(error)}`);
    assert.equal(codeOf(error), 'IDEMPOTENCY_KEY_REUSED');
    assert.notEqual(codeOf(error), 'OPERATION_STORE_CORRUPT');

    // Et le reçu du propriétaire est intact : le refus n'a rien écrit.
    const receipt = await store.read(OPERATION_ID);
    assert.equal(receipt?.fingerprint, FP1);
    assert.equal(receipt?.action, 'PAUSE');
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// D3 — barrière à N concurrents
// --------------------------------------------------------------------------

test('(D3) trente-deux appels simultanés, même clé : un propriétaire, zéro corruption', async (t) => {
  const b = await box();
  try {
    const held = gate();
    let reached!: () => void;
    const windowOpen = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let publishings = 0;
    const N = 32;
    let waiting = 0;
    const allQueued = signal();
    const store = b.store('instance-1', {
      onPublishing: async () => {
        publishings += 1;
        reached();
        await held.promise;
      },
      onWaitingForPublication: () => {
        waiting += 1;
        if (waiting === N - 1) allQueued.fire();
      },
    });

    const first = store.claim({ idempotencyKey: KEY, fingerprint: FP1, action: 'PAUSE', runId: 'CCR-20260402-001' });
    await windowOpen;

    // Les trente et un autres arrivent pendant que la fenêtre est ouverte.
    const rest = Array.from({ length: N - 1 }, () =>
      store.claim({ idempotencyKey: KEY, fingerprint: FP1, action: 'PAUSE', runId: 'CCR-20260402-001' }),
    );
    // Aucun n'est libéré avant que tous aient constaté qu'ils devaient attendre.
    const barrier = await firstOf(allQueued.promise, Promise.race(rest));
    assert.equal(barrier, 'ATTEND', 'un rival a tranché alors que rien n’était publié');
    assert.equal(waiting, N - 1, 'tous les rivaux se sont mis en file');
    held.open();

    const results = await Promise.all([first, ...rest].map((p) => p.then(
      (value: ClaimResult) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )));

    const failures = results.filter((r) => !r.ok);
    const claimed = results.filter((r) => r.ok && r.value.kind === 'CLAIMED');
    const existing = results.filter((r) => r.ok && r.value.kind === 'EXISTING');
    t.diagnostic(`${String(N)} appels → ${String(claimed.length)} CLAIMED · ${String(existing.length)} EXISTING · ${String(failures.length)} erreur(s) · onPublishing appelé ${String(publishings)} fois`);

    assert.deepEqual(failures.map((f) => codeOf((f as { error: unknown }).error)), []);
    assert.equal(claimed.length, 1, 'un seul propriétaire, donc un seul effet possible');
    assert.equal(existing.length, N - 1);
    assert.equal(publishings, 1, 'une seule publication : personne n’a recréé le fichier');
    const ids = new Set(results.map((r) => (r.ok ? r.value.receipt.operation_id : 'erreur')));
    assert.deepEqual([...ids], [OPERATION_ID], 'un seul operation_id');
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// D4 — artefact durable incomplet après crash
// --------------------------------------------------------------------------

test('(D4) claim interrompu avant publication : jamais absent, jamais réclamé, jamais rejoué', async (t) => {
  const b = await box();
  try {
    // L'état exact que laisse un processus tué entre la création exclusive et
    // l'écriture du reçu. Une nouvelle instance le découvre au démarrage.
    await mkdir(path.dirname(b.receiptPath), { recursive: true });
    await writeFile(b.receiptPath, '', 'utf8');

    const store = b.store('instance-2');

    // 1. Jamais « absent ».
    const readError = await store.read(OPERATION_ID).then(() => undefined, (e: unknown) => e);
    t.diagnostic(`lecture d'un artefact incomplet → ${codeOf(readError)}`);
    assert.equal(codeOf(readError), 'OPERATION_STORE_CORRUPT');
    assert.match(
      isCcrError(readError) ? String((readError.details as { reason?: string } | undefined)?.reason) : '',
      /publication interrompue/,
      'la cause est nommée, pas devinée',
    );

    // 2. Jamais un second claim : la même clé est refusée, pas réattribuée.
    const claimError = await store
      .claim({ idempotencyKey: KEY, fingerprint: FP1, action: 'PAUSE', runId: 'CCR-20260402-001' })
      .then(() => undefined, (e: unknown) => e);
    t.diagnostic(`claim sur artefact incomplet → ${codeOf(claimError)}`);
    assert.equal(codeOf(claimError), 'OPERATION_STORE_CORRUPT');

    // 3. Jamais supprimé pour repartir à neuf.
    const still = await readFile(b.receiptPath, 'utf8');
    assert.equal(still.length, 0, "l'artefact est conservé : le supprimer autoriserait un rejeu");

    // 4. Et l'échec est stable : réessayer ne finit pas par céder.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const again = await store
        .claim({ idempotencyKey: KEY, fingerprint: FP1, action: 'PAUSE', runId: 'CCR-20260402-001' })
        .then(() => 'ACCORDÉ', (e: unknown) => codeOf(e));
      assert.equal(again, 'OPERATION_STORE_CORRUPT', `tentative ${String(attempt + 2)}`);
    }
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// D5 — les reçus déjà publiés se lisent comme avant
// --------------------------------------------------------------------------

test('(D5) reçus existants : RUNNING, SUCCEEDED, FAILED et UNKNOWN restent lisibles', async (t) => {
  const b = await box();
  try {
    const store = b.store('instance-1');

    // RUNNING de l'instance courante.
    const claimed = await store.claim({ idempotencyKey: KEY, fingerprint: FP1, action: 'PAUSE', runId: 'CCR-20260402-001' });
    assert.equal(claimed.kind, 'CLAIMED');
    assert.equal((await store.read(OPERATION_ID))?.status, 'RUNNING');

    // Le même reçu vu par une instance suivante : UNKNOWN, sans écriture.
    const before = await readFile(b.receiptPath, 'utf8');
    const next = b.store('instance-2');
    assert.equal((await next.read(OPERATION_ID))?.status, 'UNKNOWN');
    assert.equal(await readFile(b.receiptPath, 'utf8'), before, 'la dérivation ne réécrit rien');

    // Puis les deux terminaisons.
    for (const [key, patch, expected] of [
      ['cle-succes-000001', { status: 'SUCCEEDED' as const, revisionAfter: `sha256:${'a'.repeat(64)}` }, 'SUCCEEDED'],
      ['cle-echec-0000001', { status: 'FAILED' as const, errorCode: 'STALE_REVISION' }, 'FAILED'],
    ] as const) {
      const id = `op_${createHash('sha256').update(key, 'utf8').digest('hex')}`;
      await store.claim({ idempotencyKey: key, fingerprint: FP1, action: 'PAUSE', runId: 'CCR-20260402-001' });
      await store.settle(id, patch);
      const settled = await store.read(id);
      assert.equal(settled?.status, expected);
      // Un statut terminal ne dérive jamais : il ne dépend plus de l'instance.
      assert.equal((await next.read(id))?.status, expected);
    }

    // Un reçu écrit par une version antérieure — même format, aucune migration.
    const legacyKey = 'cle-heritee-00001';
    const legacyDigest = createHash('sha256').update(legacyKey, 'utf8').digest('hex');
    const legacyPath = path.join(b.dataRoot.controlDir, OPERATIONS_DIR_NAME, legacyDigest.slice(0, 2), `${legacyDigest}.json`);
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(
      legacyPath,
      `${JSON.stringify({
        schema_version: 1,
        operation_id: `op_${legacyDigest}`,
        server_instance_id: 'instance-slice-4',
        run_id: 'CCR-20260402-001',
        action: 'DECIDE',
        fingerprint: FP2,
        created_at: '2026-08-08T10:00:00.000Z',
        updated_at: '2026-08-08T10:00:01.000Z',
        status: 'SUCCEEDED',
        revision_after: `sha256:${'b'.repeat(64)}`,
      }, null, 2)}\n`,
      'utf8',
    );
    const legacy = await store.read(`op_${legacyDigest}`);
    t.diagnostic(`reçu hérité → ${String(legacy?.status)} · action=${String(legacy?.action)}`);
    assert.equal(legacy?.status, 'SUCCEEDED');
    assert.equal(legacy?.revision_after, `sha256:${'b'.repeat(64)}`);

    // Et une retransmission sur ce reçu hérité le rend tel quel.
    const replay = await store.claim({ idempotencyKey: legacyKey, fingerprint: FP2, action: 'DECIDE', runId: 'CCR-20260402-001' });
    assert.equal(replay.kind, 'EXISTING');
    assert.equal(replay.receipt.status, 'SUCCEEDED');
  } finally {
    await b.cleanup();
  }
});

// --------------------------------------------------------------------------
// D6 — le protocole n'écrit rien de secret
// --------------------------------------------------------------------------

test('(D6) le protocole de publication n’ajoute aucun secret sur disque', async (t) => {
  const b = await box();
  const SECRET_KEY = 'cle-tres-secrete-4f7a2c';
  const SECRETS = [SECRET_KEY, 'mot-de-passe', 'texte-de-decision', 'reponse-fournisseur', 'Cookie', 'Bearer'];
  try {
    const held = gate();
    let reached!: () => void;
    const windowOpen = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const store = b.store('instance-1', {
      onPublishing: async () => {
        reached();
        await held.promise;
      },
    });

    const owner = store.claim({ idempotencyKey: SECRET_KEY, fingerprint: FP1, action: 'DECIDE', runId: 'CCR-20260402-001' });
    await windowOpen;

    // Inspection **pendant** la fenêtre : c'est là qu'un protocole bavard
    // aurait déposé un marqueur, un journal ou une trace de la clé brute.
    const during = await inventory(b.dataRoot.controlDir);
    held.open();
    await owner;
    const after = await inventory(b.dataRoot.controlDir);

    t.diagnostic(`pendant la publication : ${String(during.length)} fichier(s) · après : ${String(after.length)}`);
    for (const [label, files] of [['pendant', during], ['après', after]] as const) {
      for (const { file, content } of files) {
        for (const secret of SECRETS) {
          assert.equal(content.includes(secret), false, `${secret} trouvé ${label} dans ${path.basename(file)}`);
        }
      }
    }

    // Un seul artefact durable, et c'est le reçu lui-même.
    assert.deepEqual(after.map((f) => path.basename(f.file)), [`${OPERATION_ID_OF(SECRET_KEY).slice(3)}.json`]);
    const receipt = JSON.parse(after[0]?.content ?? '{}') as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(receipt).sort(),
      ['action', 'created_at', 'fingerprint', 'operation_id', 'run_id', 'schema_version', 'server_instance_id', 'status', 'updated_at'],
      'aucun champ nouveau : le format est inchangé',
    );
  } finally {
    await b.cleanup();
  }
});

const OPERATION_ID_OF = (key: string): string => `op_${createHash('sha256').update(key, 'utf8').digest('hex')}`;

async function inventory(dir: string): Promise<{ file: string; content: string }[]> {
  const found: { file: string; content: string }[] = [];
  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name !== 'server.lock') found.push({ file: full, content: await readFile(full, 'utf8') });
    }
  };
  await walk(path.join(dir, OPERATIONS_DIR_NAME));
  return found;
}
