#!/usr/bin/env node
/**
 * Fausse CLI fournisseur pour les tests d'orchestration de connexion.
 *
 * Elle sert les **trois** commandes qu'un login met en jeu — version, statut,
 * connexion — parce que le service résout un seul launcher et l'utilise aussi
 * bien pour sonder que pour connecter.
 *
 * Elle porte un état persistant : la commande de connexion peut réellement
 * faire basculer le statut rapporté ensuite. C'est ce qui permet de vérifier
 * que CCR conclut sur le probe qui suit, et non sur le code de sortie.
 *
 * Pilotage :
 *   FAKE_LOGIN_AGENT       `claude` ou `codex` — dicte la forme des sorties
 *   FAKE_LOGIN_STATE_FILE  état JSON : { auth, loginExit, loginEffect }
 *   FAKE_LOGIN_ARGS_FILE   journal des invocations reçues
 *
 * La commande de connexion écrit volontairement sur `stdout` et `stderr` : ces
 * flux appartiennent au terminal humain. Si un jour ils réapparaissaient dans
 * une valeur CCR, les tests le verraient.
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const agent = process.env.FAKE_LOGIN_AGENT ?? 'claude';
const stateFile = process.env.FAKE_LOGIN_STATE_FILE;

if (process.env.FAKE_LOGIN_ARGS_FILE) {
  appendFileSync(process.env.FAKE_LOGIN_ARGS_FILE, `${JSON.stringify(args)}\n`, 'utf8');
}

function readState() {
  const defaults = { auth: 'unauthenticated', loginExit: 0, loginEffect: 'authenticate' };
  if (!stateFile) return defaults;
  try {
    return { ...defaults, ...JSON.parse(readFileSync(stateFile, 'utf8')) };
  } catch {
    return defaults;
  }
}

function writeAuth(auth) {
  if (!stateFile) return;
  writeFileSync(stateFile, JSON.stringify({ ...readState(), auth }), 'utf8');
}

const state = readState();

const isVersion = args[0] === '--version';
const isStatus =
  agent === 'claude'
    ? args[0] === 'auth' && args[1] === 'status'
    : args[0] === 'login' && args[1] === 'status';
const isLogin =
  agent === 'claude' ? args[0] === 'auth' && args[1] === 'login' : args[0] === 'login' && args.length === 1;

/** Sortie de statut, dans la forme réellement observée pour chaque CLI. */
function emitStatus() {
  if (agent === 'claude') {
    switch (state.auth) {
      case 'authenticated':
        process.stdout.write(
          `${JSON.stringify({
            loggedIn: true,
            authMethod: 'claude.ai',
            email: 'temoin.pii@exemple-ccr.test',
            orgName: 'Organisation temoin PII',
          })}\n`,
        );
        break;
      case 'unknown':
        process.stdout.write('statut indeterminable\n');
        break;
      default:
        process.stdout.write(`${JSON.stringify({ loggedIn: false })}\n`);
        break;
    }
    return;
  }

  switch (state.auth) {
    case 'authenticated':
      // stdout vide, message sur stderr, exit 0 : le cas réel.
      process.stderr.write('Logged in using ChatGPT\n');
      break;
    case 'unknown':
      process.stderr.write('ERROR: error parsing config.toml at line 12\n');
      process.exitCode = 1;
      break;
    default:
      process.stderr.write('Not logged in\n');
      process.exitCode = 1;
      break;
  }
}

if (isVersion) {
  process.stdout.write(agent === 'claude' ? '2.1.224 (Claude Code)\n' : 'codex-cli 0.146.0\n');
} else if (isStatus) {
  emitStatus();
} else if (isLogin) {
  // Contenu typique d'un flow réel : URL, code temporaire, identité. Rien de
  // tout cela ne doit pouvoir atteindre une valeur CCR.
  //
  // Ces flux étant hérités du terminal, ils apparaissent dans la sortie du
  // lanceur de tests : c'est précisément la preuve que CCR ne les capture pas.
  // Ils ne sont émis que pour le test qui les vérifie, afin de ne pas polluer
  // la suite entière.
  if (process.env.FAKE_LOGIN_EMIT_SECRETS === '1') {
    process.stdout.write('OUVERTURE-NAVIGATEUR https://exemple-ccr.test/device?code=TEMOIN-CODE-9F3A\n');
    process.stderr.write('login temoin.pii@exemple-ccr.test token=TEMOIN-TOKEN-ABCDEF\n');
  }

  if (state.loginEffect === 'authenticate') writeAuth('authenticated');
  else if (state.loginEffect === 'unknown') writeAuth('unknown');

  process.exitCode = Number(state.loginExit ?? 0);
} else {
  process.stderr.write(`commande inattendue: ${args.join(' ')}\n`);
  process.exitCode = 64;
}
