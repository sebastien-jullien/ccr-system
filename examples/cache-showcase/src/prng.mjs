/**
 * Générateur pseudo-aléatoire gelé.
 *
 * Chaîne de dérivation, sans variante permise :
 *
 * ```text
 * chaîne → UTF-8 → SHA-256 → quatre premiers octets → uint32 BIG-ENDIAN
 *        → mulberry32 canonique
 * ```
 *
 * `Math.random()` n'est utilisé nulle part. Aucun tirage caché, aucun
 * échantillonnage par rejet : chaque tirage consommé est un tirage prévu.
 */

import { createHash } from 'node:crypto';

export const UINT32_RANGE = 4294967296;

/** Un seul octet 0x00, séparateur canonique de tous les préimages. */
export const NUL = '\u0000';

/** SHA-256 brut d'une chaîne, encodée en UTF-8. */
export function digestOf(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest();
}

/** Quatre premiers octets du condensat, lus en uint32 gros-boutiste. */
export function seedFromString(text) {
  return digestOf(text).readUInt32BE(0);
}

/**
 * mulberry32 canonique, rendant des `uint32` et non des flottants.
 *
 * Le format de sortie compte : `INDEX` divise par 2^32, et convertir en
 * flottant avant l'index introduirait un arrondi qui n'est pas dans le contrat.
 */
export function mulberry32(seed) {
  let a = seed | 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

/** Générateur de tirages `uint32` amorcé par une chaîne. */
export function generatorFromString(text) {
  return mulberry32(seedFromString(text));
}

/**
 * Index gelé d'un tirage dans un ensemble de taille `n`.
 *
 * `draw * n` reste très en deçà de 2^53 pour tout `n` employé ici, donc le
 * produit est exact en double précision.
 */
export function INDEX(draw, n) {
  return Math.floor((draw * n) / UINT32_RANGE);
}

/**
 * Mélange de Fisher-Yates gelé : `i` de `length-1` vers `1`, un tirage par
 * itération, l'échange ayant lieu même lorsque `j === i`.
 */
export function fisherYates(items, next) {
  const array = [...items];
  for (let i = array.length - 1; i >= 1; i -= 1) {
    const j = INDEX(next(), i + 1);
    const swap = array[i];
    array[i] = array[j];
    array[j] = swap;
  }
  return array;
}

/** Comparateur d'un rang SHA-256 : octets bruts croissants, puis clé croissante. */
export function compareRank(a, b) {
  const byDigest = Buffer.compare(a.digest, b.digest);
  if (byDigest !== 0) return byDigest;
  if (a.key < b.key) return -1;
  if (a.key > b.key) return 1;
  return 0;
}

/**
 * Classement déterministe d'un ensemble de clés sous une graine de nommage.
 *
 * Préimage : `graine ‖ 0x00 ‖ clé`. Départage final par clé croissante.
 */
export function rankByDigest(seed, keys) {
  return keys
    .map((key) => ({ key, digest: digestOf(`${seed}${NUL}${key}`) }))
    .sort(compareRank)
    .map((entry) => entry.key);
}
