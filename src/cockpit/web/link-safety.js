/**
 * Validation d'URL — **le seul** point du frontend qui produise un `href`.
 *
 * ## Pourquoi une primitive dédiée
 *
 * La frontière stored-XSS du cockpit interdit qu'une valeur reçue devienne un
 * attribut de navigation. Rendre des liens Markdown exige une exception ; une
 * exception large serait la fin de la frontière. Celle-ci est donc **étroite et
 * nommée** : une fonction, un fichier, une règle.
 *
 * ```text
 * destination candidate (Marked, humain, modèle)
 *   → safeHref
 *   → http/https absolu, ou rien
 * ```
 *
 * Marked propose ; CCR décide. Un analyseur Markdown n'est pas une autorité de
 * sécurité, et ne le devient pas parce qu'il est éprouvé.
 *
 * ## Analyse, jamais préfixe
 *
 * La validation passe par un analyseur d'URL réel. Comparer des préfixes de
 * chaîne échoue sur les espaces, les tabulations, la casse, les caractères de
 * contrôle et les encodages — `java\tscript:` en est l'exemple classique.
 *
 * ## Absolu uniquement
 *
 * Une URL relative est refusée, et c'est délibéré : le cockpit est une origine
 * locale servant des faits CCR, et un lien relatif issu d'un contenu non fiable
 * désignerait ses propres routes.
 */

/**
 * `href` sûr, ou `null`.
 *
 * `null` n'est pas un échec : c'est un refus. L'appelant garde le contenu
 * visible, sans le rendre cliquable.
 */
export function safeHref(raw) {
  if (typeof raw !== 'string') return null;
  const candidate = raw.trim();
  if (candidate.length === 0) return null;

  let url;
  try {
    // Sans base : une URL relative ou protocole-relative lève, donc échoue.
    url = new URL(candidate);
  } catch {
    return null;
  }

  // Liste blanche fermée. Tout le reste — javascript:, data:, file:, mailto:,
  // blob:, vbscript: — est refusé sans être énuméré : une liste noire oublie.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.href;
}

/** Attributs imposés à tout lien externe accepté. Table close. */
export const SAFE_LINK_ATTRIBUTES = Object.freeze({
  target: '_blank',
  rel: 'noopener noreferrer',
  referrerpolicy: 'no-referrer',
});
