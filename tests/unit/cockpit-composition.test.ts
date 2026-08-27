/**
 * Composition long-lived du cockpit — fermeture de la limite L4 (Slice 2, §28).
 *
 * L4 : le registre d'opérations de l'hôte doit être **le même objet** pour le
 * service qui exécute et pour le read model qui observe. Deux instances
 * feraient voir au cockpit des verrous « orphelins » qui sont en réalité les
 * siens — exactement l'erreur que le Slice 0D a fermée côté classification.
 *
 * L'assertion porte donc sur l'identité d'objet, pas sur l'égalité structurelle
 * (deux registres vides sont structurellement identiques et fonctionnellement
 * catastrophiques).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { composeCcrApplication } from '../../src/cli/composition.ts';
import { createHostOperationRegistry } from '../../src/lock/host-operation-registry.ts';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir.ts';

test('(C1) un registre fourni est partagé, à l’identique, par les deux couches', async () => {
  const dir = await makeTempDir('ccr-compo-');
  try {
    const registry = createHostOperationRegistry();
    const app = composeCcrApplication({ runsDir: path.join(dir, 'runs'), hostRegistry: registry });

    assert.equal(app.runService.hostRegistry, registry, 'même objet côté service');
    assert.equal(app.readModel.hostRegistry, registry, 'même objet côté read model');
    assert.equal(app.runService.hostRegistry, app.readModel.hostRegistry);
    // Et les réglages restent partagés (L1, déjà fermée au Slice 1).
    assert.equal(app.runService.maxTransferBytes, app.readModel.settings.maxTransferBytes);
  } finally {
    await removeTempDir(dir);
  }
});

test('(C2) hors serveur, aucun registre n’est inventé', async () => {
  const dir = await makeTempDir('ccr-compo-cli-');
  try {
    const app = composeCcrApplication({ runsDir: path.join(dir, 'runs') });
    // La CLI est un processus par commande : prétendre observer des opérations
    // vivantes de l'hôte y serait faux.
    assert.equal(app.runService.hostRegistry, undefined);
    assert.equal(app.readModel.hostRegistry, undefined);
  } finally {
    await removeTempDir(dir);
  }
});

test('(C3) sur le chemin de production : le cockpit compose un seul registre', async () => {
  const dir = await makeTempDir('ccr-compo-prod-');
  try {
    const runsDir = path.join(dir, 'runs');
    await mkdir(runsDir, { recursive: true });
    const { startCockpit } = await import('../../src/cockpit/cockpit-service.ts');

    const instance = await startCockpit({ runsDir, port: 0 });
    try {
      assert.equal(instance.application.runService.hostRegistry, instance.registry);
      assert.equal(instance.application.readModel.hostRegistry, instance.registry);
      assert.equal(
        instance.application.runService.hostRegistry,
        instance.application.readModel.hostRegistry,
      );
    } finally {
      assert.equal(await instance.stop(), 'RELEASED');
    }
  } finally {
    await removeTempDir(dir);
  }
});
