#!/usr/bin/env node
/**
 * Fausse CLI Claude pour les tests de probe runtime.
 *
 * Elle reproduit le contrat **observé** sur la CLI réelle 2.1.224 :
 * `claude auth status` répond exit 0 avec un document JSON portant `loggedIn`,
 * accompagné de données personnelles. Les branches d'erreur sont, elles, des
 * hypothèses de robustesse — elles prouvent le classement, pas le contrat
 * fournisseur.
 *
 * Pilotage :
 *   FAKE_CLAUDE_RUNTIME_MODE       scénario émis
 *   FAKE_CLAUDE_RUNTIME_ARGS_FILE  fichier où consigner les arguments reçus
 *
 * Aucun `process.exit()` après écriture : sous Windows cela tronque les tubes.
 */

import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const mode = process.env.FAKE_CLAUDE_RUNTIME_MODE ?? 'ok';

if (process.env.FAKE_CLAUDE_RUNTIME_ARGS_FILE) {
  appendFileSync(process.env.FAKE_CLAUDE_RUNTIME_ARGS_FILE, `${JSON.stringify(args)}\n`, 'utf8');
}

const isVersion = args[0] === '--version';
const isAuthStatus = args[0] === 'auth' && args[1] === 'status';

/** Sortie réelle, PII comprise : le probe ne doit en retenir que `loggedIn`. */
const AUTHENTICATED_PAYLOAD = {
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: 'temoin.pii@exemple-ccr.test',
  orgId: '9b68f0df-0000-0000-0000-51df4fa92b06',
  orgName: "Organisation temoin PII",
  subscriptionType: 'max',
};

if (isVersion) {
  switch (mode) {
    case 'version-fail':
      process.stderr.write('claude: internal error\n');
      process.exitCode = 3;
      break;
    case 'version-unknown':
      process.stdout.write('Claude Code (build inconnue)\n');
      break;
    case 'version-hang':
      setTimeout(() => undefined, 600_000);
      break;
    default:
      process.stdout.write('2.1.224 (Claude Code)\n');
      break;
  }
} else if (isAuthStatus) {
  switch (mode) {
    case 'logged-out':
      process.stdout.write(`${JSON.stringify({ loggedIn: false })}\n`);
      break;

    case 'logged-out-exit1':
      process.stdout.write(`${JSON.stringify({ loggedIn: false, authMethod: null })}\n`);
      process.exitCode = 1;
      break;

    // Sous-commande absente d'une future CLI : exit 1, aucun énoncé.
    case 'unknown-command':
      process.stderr.write("error: unknown command 'auth'\n");
      process.exitCode = 1;
      break;

    // PII volontaire : un diagnostic recopié la ferait fuiter.
    case 'unexpected-failure':
      process.stderr.write('claude: internal error for temoin.pii@exemple-ccr.test (org 9b68f0df)\n');
      process.exitCode = 7;
      break;

    case 'unrecognized-output':
      process.stdout.write('Authentication: probably fine?\n');
      break;

    // Énoncé positif contredit par le code de sortie.
    case 'contradiction':
      process.stdout.write(`${JSON.stringify(AUTHENTICATED_PAYLOAD)}\n`);
      process.exitCode = 4;
      break;

    case 'auth-on-stderr':
      process.stderr.write(`${JSON.stringify(AUTHENTICATED_PAYLOAD)}\n`);
      break;

    case 'auth-hang':
      setTimeout(() => undefined, 600_000);
      break;

    default:
      process.stdout.write(`${JSON.stringify(AUTHENTICATED_PAYLOAD, null, 2)}\n`);
      break;
  }
} else {
  // Toute autre invocation est une anomalie de test : `login` ne doit jamais
  // être atteint par un probe.
  process.stderr.write(`commande inattendue: ${args.join(' ')}\n`);
  process.exitCode = 64;
}
