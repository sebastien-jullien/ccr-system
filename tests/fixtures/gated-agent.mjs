#!/usr/bin/env node
/**
 * Exécutable d'agent **contrôlé** : il répond correctement, mais seulement
 * quand le test l'y autorise.
 *
 * Il est destiné à être désigné par `CCR_CLAUDE_BIN` / `CCR_CODEX_BIN` — la
 * couture de production déjà documentée dans `src/cli/deps.ts`. Aucun contrat
 * de la CLI n'est modifié : de son point de vue, c'est une CLI d'agent parmi
 * d'autres, simplement lente.
 *
 * C'est ce qui permet d'observer une opération longue **réellement en vol**
 * dans un processus CCR séparé, sans dépenser un appel fournisseur.
 *
 * Pilotage :
 *   CCR_GATE_DIR   répertoire d'échange (obligatoire)
 *   CCR_GATE_KIND  `claude` (défaut) ou `codex`
 *
 * Protocole :
 *   à l'entrée        écrit `<CCR_GATE_DIR>/started-<pid>.json`
 *   puis              attend l'apparition de `<CCR_GATE_DIR>/release`
 *   puis              émet l'enveloppe attendue et sort avec 0
 *
 * Le marqueur d'entrée est écrit **après** lecture du prompt : bloquer avant
 * de vider le tube d'entrée pourrait suspendre le parent, et l'on observerait
 * alors un blocage d'écriture au lieu d'un appel d'agent en cours.
 */

import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const gateDir = process.env.CCR_GATE_DIR;
const kind = process.env.CCR_GATE_KIND ?? 'claude';

if (!gateDir) {
  process.stderr.write('gated-agent: CCR_GATE_DIR manquant\n');
  process.exitCode = 2;
} else {
  const readStdin = () =>
    new Promise((resolve) => {
      let data = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        data += chunk;
      });
      process.stdin.on('end', () => resolve(data));
      process.stdin.on('error', () => resolve(data));
      process.stdin.resume();
    });

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Le format se déduit de l'invocation elle-même : `codex exec …` contre les
  // drapeaux de Claude. Un seul fichier peut ainsi servir les deux `CCR_*_BIN`
  // sans que le test ait à deviner quel agent le tour va solliciter.
  const isCodex = kind === 'codex' || args[0] === 'exec';
  const prompt = isCodex
    ? args[args.length - 1] === '-'
      ? await readStdin()
      : (args[args.length - 1] ?? '')
    : await readStdin();

  // Marqueur d'entrée : le fournisseur est atteint, l'opération est en vol.
  writeFileSync(
    path.join(gateDir, `started-${String(process.pid)}.json`),
    JSON.stringify({ pid: process.pid, kind, args, promptBytes: Buffer.byteLength(prompt, 'utf8') }),
    'utf8',
  );

  const release = path.join(gateDir, 'release');
  while (!existsSync(release)) await sleep(20);

  if (isCodex) {
    const isResume = args[0] === 'exec' && args[1] === 'resume';
    const threadId = isResume ? args[2] : 'thread-fixture-0001';
    const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
    emit({ type: 'thread.started', thread_id: threadId });
    emit({ type: 'turn.started' });
    emit({
      type: 'item.completed',
      item: { id: 'item_1', type: 'agent_message', text: `GATED:${prompt.length}` },
    });
    emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
  } else {
    const resumeIndex = args.indexOf('--resume');
    const sessionId = resumeIndex >= 0 ? args[resumeIndex + 1] : 'claude-fixture-0001';
    process.stdout.write(
      `${JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: sessionId,
        result: `GATED:${prompt.length}`,
        num_turns: 1,
        duration_ms: 12,
        total_cost_usd: 0,
      })}\n`,
    );
  }
}
