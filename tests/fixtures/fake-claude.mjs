#!/usr/bin/env node
/**
 * Faux exécutable Claude Code pour les tests unitaires de `ClaudeAdapter`.
 *
 * Il ne simule PAS la continuité conversationnelle native : seule la CLI
 * réelle peut la démontrer (voir tests/integration).
 *
 * Le scénario `nonzero` reproduit fidèlement l'enveloppe réellement observée
 * sur claude 2.1.220 lors d'un échec d'authentification : `subtype: "success"`
 * accompagné de `is_error: true` et d'un code de sortie 1.
 *
 * Pilotage :
 *   FAKE_CLAUDE_MODE       scénario émis
 *   FAKE_CLAUDE_ARGS_FILE  fichier où consigner les arguments reçus
 */

import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const mode = process.env.FAKE_CLAUDE_MODE ?? 'ok';

if (process.env.FAKE_CLAUDE_ARGS_FILE) {
  writeFileSync(process.env.FAKE_CLAUDE_ARGS_FILE, JSON.stringify(args), 'utf8');
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

const resumeIndex = args.indexOf('--resume');
const sessionId = resumeIndex >= 0 ? args[resumeIndex + 1] : 'claude-fixture-0001';

const prompt = await readStdin();

const envelope = (overrides) =>
  process.stdout.write(
    `${JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: sessionId,
      result: `ECHO:${prompt}`,
      num_turns: 1,
      duration_ms: 12,
      total_cost_usd: 0,
      ...overrides,
    })}\n`,
  );

switch (mode) {
  case 'hang':
    setTimeout(() => undefined, 600_000);
    break;

  case 'nonzero':
    envelope({
      is_error: true,
      result: 'Failed to authenticate: OAuth session expired and could not be refreshed',
    });
    process.exitCode = 1;
    break;

  case 'is-error':
    envelope({ is_error: true, result: 'quota dépassé' });
    break;

  case 'unparsable':
    process.stdout.write('{"type":"result","session_id":');
    break;

  case 'empty':
    break;

  case 'no-session':
    envelope({ session_id: undefined });
    break;

  case 'no-result':
    envelope({ result: undefined });
    break;

  case 'wrong-type':
    envelope({ type: 'system' });
    break;

  case 'mismatch':
    envelope({ session_id: 'claude-autre-9999' });
    break;

  case 'noise':
    process.stderr.write('warning: node deprecation\n');
    process.stdout.write('Avertissement non structuré imprimé avant le JSON\n');
    envelope({});
    break;

  case 'len':
    envelope({ result: `LEN:${prompt.length}` });
    break;

  default:
    envelope({});
    break;
}
