#!/usr/bin/env node
/**
 * Fausse CLI Codex pour les tests de probe runtime.
 *
 * Elle reproduit le contrat **observé** sur la CLI réelle 0.146.0 :
 * `codex login status` répond exit 0 en écrivant sur `stderr`, `stdout`
 * restant vide. Les branches d'erreur sont des hypothèses de robustesse.
 *
 * Pilotage :
 *   FAKE_CODEX_RUNTIME_MODE       scénario émis
 *   FAKE_CODEX_RUNTIME_ARGS_FILE  fichier où consigner les arguments reçus
 */

import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const mode = process.env.FAKE_CODEX_RUNTIME_MODE ?? 'ok';

if (process.env.FAKE_CODEX_RUNTIME_ARGS_FILE) {
  appendFileSync(process.env.FAKE_CODEX_RUNTIME_ARGS_FILE, `${JSON.stringify(args)}\n`, 'utf8');
}

const isVersion = args[0] === '--version';
const isLoginStatus = args[0] === 'login' && args[1] === 'status';

if (isVersion) {
  switch (mode) {
    case 'version-fail':
      process.stderr.write('error: failed to load configuration\n');
      process.exitCode = 1;
      break;
    case 'version-unknown':
      process.stdout.write('codex-cli (edge)\n');
      break;
    case 'version-hang':
      setTimeout(() => undefined, 600_000);
      break;
    default:
      process.stdout.write('codex-cli 0.146.0\n');
      break;
  }
} else if (isLoginStatus) {
  switch (mode) {
    // Session absente, message sur stderr : forme observée par la V1.
    case 'logged-out-stderr':
      process.stderr.write('Not logged in\n');
      process.exitCode = 1;
      break;

    // Même énoncé sur stdout : une version fournisseur peut le faire.
    case 'logged-out-stdout':
      process.stdout.write('Not logged in. Run `codex login`.\n');
      process.exitCode = 1;
      break;

    // Exit 1 surchargé : erreur de configuration, pas une session absente.
    case 'config-error':
      process.stderr.write(
        'ERROR: error parsing config.toml: invalid type: string, expected a map at line 12\n',
      );
      process.exitCode = 1;
      break;

    // PII volontaire : un diagnostic recopié la ferait fuiter.
    case 'exit1-plain':
      process.stderr.write(
        'ERROR: unexpected failure while reading local state for temoin.pii@exemple-ccr.test (org org_TEMOIN_PII)\n',
      );
      process.exitCode = 1;
      break;

    case 'unexpected-failure':
      process.stderr.write('ERROR: subcommand not supported\n');
      process.exitCode = 2;
      break;

    case 'authenticated-with-pii':
      process.stderr.write('Logged in using ChatGPT (temoin.pii@exemple-ccr.test, org org_TEMOIN_PII)\n');
      break;

    case 'login-hang':
      setTimeout(() => undefined, 600_000);
      break;

    default:
      // stdout volontairement vide : c'est le cas réel.
      process.stderr.write('Logged in using ChatGPT\n');
      break;
  }
} else {
  process.stderr.write(`commande inattendue: ${args.join(' ')}\n`);
  process.exitCode = 64;
}
