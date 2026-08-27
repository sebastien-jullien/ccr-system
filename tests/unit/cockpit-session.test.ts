/**
 * Session locale du cockpit (Slice 2, §16, §37).
 *
 * Le cookie est la seule chose qui sépare une API de lecture locale — contenus
 * intégraux d'agents, identifiants de sessions natives, chemin de travail — de
 * n'importe quelle page ouverte dans le même navigateur.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SESSION_COOKIE_NAME,
  SESSION_SECRET_BYTES,
  createSessionSecret,
  readSessionCookie,
  sessionCookieHeader,
  sessionMatches,
} from '../../src/cockpit/session.ts';

test('(S1) secret : au moins 256 bits, et jamais deux fois le même', () => {
  assert.ok(SESSION_SECRET_BYTES * 8 >= 256, 'entropie ≥ 256 bits');

  const secrets = new Set(Array.from({ length: 200 }, () => createSessionSecret()));
  assert.equal(secrets.size, 200, 'aucune collision');

  for (const secret of secrets) {
    assert.ok(Buffer.from(secret, 'base64url').byteLength >= 32);
    // Sûr en URL et en en-tête : pas de « = », « + », « / ».
    assert.match(secret, /^[A-Za-z0-9_-]+$/);
  }
});

test('(S2) cookie : HttpOnly, SameSite=Strict, Path=/ — sans Domain ni Secure', () => {
  const header = sessionCookieHeader('valeur-test');

  assert.ok(header.startsWith(`${SESSION_COOKIE_NAME}=valeur-test;`));
  assert.match(header, /;\s*HttpOnly/);
  assert.match(header, /;\s*SameSite=Strict/);
  assert.match(header, /;\s*Path=\//);
  assert.equal(/Domain=/i.test(header), false, 'aucun Domain : pas de fuite vers un sous-domaine');
  // `Secure` sur http://127.0.0.1 empêcherait le renvoi du cookie : le poser
  // annoncerait une protection tout en cassant l'authentification.
  assert.equal(/;\s*Secure/i.test(header), false);
  // Aucune persistance : le cookie meurt avec le navigateur.
  assert.equal(/Max-Age=|Expires=/i.test(header), false);
});

test('(S3) lecture du cookie parmi d’autres, et absence', () => {
  assert.equal(readSessionCookie(undefined), undefined);
  assert.equal(readSessionCookie('autre=1'), undefined);
  assert.equal(readSessionCookie(`${SESSION_COOKIE_NAME}=`), undefined);
  assert.equal(readSessionCookie(`a=1; ${SESSION_COOKIE_NAME}=xyz; b=2`), 'xyz');
  assert.equal(readSessionCookie(`${SESSION_COOKIE_NAME}=xyz`), 'xyz');
  // Un nom qui *contient* celui attendu ne doit pas passer.
  assert.equal(readSessionCookie(`x_${SESSION_COOKIE_NAME}=xyz`), undefined);
});

test('(S4) comparaison : exacte, et insensible à la longueur du préfixe correct', () => {
  const secret = createSessionSecret();

  assert.equal(sessionMatches(secret, secret), true);
  assert.equal(sessionMatches(secret, undefined), false);
  assert.equal(sessionMatches(secret, ''), false);
  assert.equal(sessionMatches(secret, secret.slice(0, -1)), false);
  assert.equal(sessionMatches(secret, `${secret}x`), false);
  assert.equal(sessionMatches(secret, createSessionSecret()), false);
});
