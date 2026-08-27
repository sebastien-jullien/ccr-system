/**
 * Session locale du cockpit (V0.2 §25.4).
 *
 * Le secret protège **aussi les `GET`** : les lectures exposent les contenus
 * intégraux des réponses d'agents, les identifiants de sessions natives et le
 * chemin de travail du poste. Une API locale en lecture seule n'est donc pas
 * une API publique.
 *
 * ```text
 * Cookie      ccr_cockpit_session
 * Entropie    256 bits, générateur cryptographique
 * HttpOnly    oui          inaccessible à tout script de page
 * SameSite    Strict       aucune requête déclenchée depuis un autre site
 * Path        /
 * Domain      absent       le cookie ne fuit pas vers un sous-domaine
 * Secure      NON          voir ci-dessous
 * Durée       vie du processus serveur ; jamais persisté
 * ```
 *
 * ## Pourquoi pas `Secure`
 *
 * Le cockpit sert `http://127.0.0.1`. Un cookie marqué `Secure` n'y serait
 * **jamais renvoyé** par le navigateur : le poser reviendrait à annoncer une
 * protection tout en cassant l'authentification. CCR préfère l'absence de flag
 * à un flag mensonger, et le déclare ici plutôt que de le laisser deviner.
 *
 * La confidentialité du transport repose donc sur le fait que le trafic ne
 * quitte pas l'interface loopback (§25.2), pas sur TLS.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE_NAME = 'ccr_cockpit_session';

/** 32 octets = 256 bits, conformément à §25.4. */
export const SESSION_SECRET_BYTES = 32;

/**
 * Génère un secret de session.
 *
 * Régénéré à chaque démarrage : un cookie émis par une instance précédente ne
 * peut pas authentifier la suivante.
 */
export function createSessionSecret(): string {
  return randomBytes(SESSION_SECRET_BYTES).toString('base64url');
}

/**
 * En-tête `Set-Cookie` du bootstrap.
 *
 * Aucun `Max-Age` ni `Expires` : le cookie meurt avec le navigateur, et le
 * secret meurt avec le processus.
 */
export function sessionCookieHeader(secret: string): string {
  return `${SESSION_COOKIE_NAME}=${secret}; HttpOnly; SameSite=Strict; Path=/`;
}

/** Extrait la valeur du cookie de session d'un en-tête `Cookie` brut. */
export function readSessionCookie(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== SESSION_COOKIE_NAME) continue;
    const value = part.slice(separator + 1).trim();
    return value.length === 0 ? undefined : value;
  }
  return undefined;
}

/**
 * Comparaison à temps constant.
 *
 * Une comparaison naïve laisserait fuir la longueur du préfixe correct ; sur
 * une boucle locale, ce canal est parfaitement exploitable.
 */
export function sessionMatches(expected: string, received: string | undefined): boolean {
  if (received === undefined) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
