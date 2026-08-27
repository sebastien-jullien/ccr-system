#!/usr/bin/env node
/**
 * Faux exécutable Codex pour les tests unitaires de `CodexAdapter`.
 *
 * Il ne simule PAS la continuité conversationnelle native — seule la CLI
 * réelle peut la démontrer (voir tests/integration). Il sert uniquement à
 * exercer le contrat d'analyse et les modes d'échec du flux JSONL.
 *
 * Pilotage par variables d'environnement :
 *   FAKE_CODEX_MODE       scénario émis
 *   FAKE_CODEX_ARGS_FILE  fichier où consigner les arguments reçus
 *
 * Aucun `process.exit()` n'est utilisé après écriture : sous Windows cela
 * tronque les tubes. Le code de sortie passe par `process.exitCode`.
 */

import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const mode = process.env.FAKE_CODEX_MODE ?? 'ok';

if (process.env.FAKE_CODEX_ARGS_FILE) {
  writeFileSync(process.env.FAKE_CODEX_ARGS_FILE, JSON.stringify(args), 'utf8');
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
    process.stdin.resume();
  });
}

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

const isResume = args[0] === 'exec' && args[1] === 'resume';
const threadId = isResume ? args[2] : 'thread-fixture-0001';

// Reproduit le refus réel observé : `codex exec resume` n'accepte pas `-s`.
if (isResume && (args.includes('-s') || args.includes('--sandbox'))) {
  process.stderr.write("error: unexpected argument '-s' found\n");
  process.exitCode = 2;
} else {
  const prompt = args[args.length - 1] === '-' ? await readStdin() : (args[args.length - 1] ?? '');

  switch (mode) {
    case 'hang':
      emit({ type: 'thread.started', thread_id: threadId });
      setTimeout(() => undefined, 600_000);
      break;

    case 'nonzero':
      emit({ type: 'thread.started', thread_id: threadId });
      process.stderr.write('codex: usage limit reached\n');
      process.exitCode = 7;
      break;

    case 'malformed':
      emit({ type: 'thread.started', thread_id: threadId });
      process.stdout.write('{"type":"turn.st\n');
      break;

    case 'no-type':
      emit({ foo: 1 });
      break;

    case 'incomplete':
      emit({ type: 'thread.started', thread_id: threadId });
      emit({ type: 'turn.started' });
      emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'partiel' } });
      break;

    case 'no-thread':
      emit({ type: 'turn.started' });
      emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'x' } });
      emit({ type: 'turn.completed', usage: {} });
      break;

    case 'no-message':
      emit({ type: 'thread.started', thread_id: threadId });
      emit({ type: 'turn.started' });
      emit({ type: 'turn.completed', usage: {} });
      break;

    case 'unknown':
      emit({ type: 'thread.started', thread_id: threadId });
      emit({ type: 'item.future_kind', payload: { nouveau: true } });
      emit({ type: 'turn.started' });
      emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'ok' } });
      emit({ type: 'turn.completed', usage: {} });
      break;

    case 'failed':
      emit({ type: 'thread.started', thread_id: threadId });
      emit({ type: 'turn.started' });
      emit({ type: 'turn.failed', error: { message: 'usage limit reached' } });
      break;

    case 'mismatch':
      emit({ type: 'thread.started', thread_id: 'thread-autre-9999' });
      emit({ type: 'turn.started' });
      emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'ok' } });
      emit({ type: 'turn.completed', usage: {} });
      break;

    case 'len':
      emit({ type: 'thread.started', thread_id: threadId });
      emit({ type: 'turn.started' });
      emit({
        type: 'item.completed',
        item: { id: 'item_0', type: 'agent_message', text: `LEN:${prompt.length}` },
      });
      emit({ type: 'turn.completed', usage: {} });
      break;

    default:
      emit({ type: 'thread.started', thread_id: threadId });
      emit({ type: 'turn.started' });
      emit({ type: 'item.updated', item: { id: 'item_0', type: 'reasoning' } });
      emit({
        type: 'item.completed',
        item: { id: 'item_1', type: 'agent_message', text: `ECHO:${prompt}` },
      });
      emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
      process.stderr.write('Reading additional input from stdin...\n');
      break;
  }
}
