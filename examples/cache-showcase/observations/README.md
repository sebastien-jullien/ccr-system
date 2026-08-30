# Observations

**L'arbre suivi par Git ne contient aucun artefact brut de mesure généré par le
banc.**

Trois choses distinctes, à ne pas confondre :

- **Origine.** Tout fait chiffré concernant cette fixture — latence, ratio p95,
  nombre d'entrées résidentes, entrées invalidées, coût de mutation — a pour
  source une **exécution réelle**. Les valeurs ne sont ni estimées ni inventées.
- **Artefacts bruts.** Les sorties produites par le banc sont écrites dans
  `generated/` et **ignorées par Git**. Aucune n'est versionnée.
- **Documentation curée.** Une sélection de mesures qualifiées est **transcrite
  et remise en contexte** dans la documentation versionnée. Cette présentation
  publique est éditoriale : le choix de ce qui est rapporté, de son cadrage et de
  ses réserves relève d'une rédaction, tandis que les valeurs elles-mêmes sont
  celles du banc.

---

## Statut des exécutions

```text
SOURCE DE PERFORMANCE QUALIFIÉE  =  BANC DE RECOUVREMENT
PREMIER BANC                     =  historique / non qualifiant
```

Deux exécutions réelles ont eu lieu. Les deux sont conservées. Une seule fait
autorité.

### Premier banc — historique, non qualifiant

Une exécution complète et réelle, terminée sans erreur. Elle a précédé le gel
humain de deux règles de calcul au niveau de l'implémentation :

- **P1** — la forme exacte de la projection matérialisée : `tokens` est la
  séquence complète des jetons normalisés du corps, et non un ensemble ;
- **P2** — le placement de la normalisation de la requête : une fois par lecture
  logique, à l'intérieur du chronométrage, **avant** toute consultation de cache,
  identiquement pour les quatre chemins.

Avant ce gel, l'implémentation stockait un ensemble de jetons, et deux stratégies
ne normalisaient la requête qu'en cas de manque — donc pas du tout lorsqu'elles
servaient depuis leur cache. Ces deux écarts affectent le travail réellement
mesuré. Les valeurs du premier banc ne peuvent donc pas servir de résultat
qualifié.

Une copie locale de ses sorties est conservée telle que produite dans
`generated/first-benchmark/`. **Elles n'alimentent aucune affirmation de
performance qualifiée**, et ne sont jamais comparées au banc de recouvrement pour
en retenir la plus flatteuse. Cette copie est locale et ignorée par Git : c'est
l'énoncé curé de provenance, et non ces octets, qui porte durablement l'histoire.

### Banc de recouvrement — seule source qualifiée

Il a été exécuté dans cet ordre, et seulement dans cet ordre :

```text
1  gel humain de P1 et P2
2  réparation ciblée, limitée à ces deux règles
3  qualification déterministe de la fixture — PASS
4  UNE exécution complète du banc
```

Ses mesures sont les seules employées par `qualified-benchmark.md`.

Ce que cette chronologie dit exactement : **le protocole affectant les résultats
n'était pas intégralement gelé avant la toute première exécution.** Ce document
ne le laisse pas entendre, et n'efface pas cette histoire.

---

## D'où viennent les fichiers

```bash
npm run bench
```

Le banc écrit dans `generated/`, ignoré par Git.

| Chemin | Nature | Cycle de vie |
|---|---|---|
| `generated/benchmark.json` | rapport complet, lisible par machine | **produit par `npm run bench`** ; peut être écrasé par une exécution ultérieure |
| `generated/benchmark.md` | résumé lisible, dérivé du même rapport | **produit par `npm run bench`** ; peut être écrasé par une exécution ultérieure |
| `generated/first-benchmark/` | copie locale du premier banc, retenue à la main | **n'est pas produit par `npm run bench`**, et aucune exécution ne le recrée |

Ces trois chemins sont ignorés par Git. Aucun n'est versionné, et **aucun n'est
donc garanti présent dans un clone public** — `generated/first-benchmark/`
compris : c'est une copie locale, conservée manuellement pour la traçabilité de
poste, et non un artefact publié.

Aucun de ces fichiers n'est la couche d'interprétation publique : ils ne sont ni
curés, ni commentés, ni versionnés.

## Où réside la provenance durable

La provenance publique et durable n'est pas un fichier de mesures. C'est
l'énoncé curé, versionné avec la documentation, qui décrit la chronologie :

```text
premier banc            historique / non qualifiant
   ↓
achèvement et gel de P1 et P2
   ↓
banc de recouvrement    seule source empirique qualifiée
```

Cet énoncé figure ci-dessus et dans `qualified-benchmark.md` § 10. Il subsiste
intégralement même si `generated/` disparaît : c'est lui qui porte la provenance,
pas les octets bruts du premier banc.

La couche curée est le fichier voisin :

```text
qualified-benchmark.md
```

---

## Ce que porte un résultat

Chaque rapport nomme la machine qui l'a produit — version de Node, plateforme,
architecture, modèle de processeur, nombre de cœurs logiques. Il ne nomme ni la
machine par son nom, ni l'utilisateur, ni un répertoire personnel, ni
l'environnement.

Cette précision compte : la cible R1 est un **ratio** au p95 de la référence,
mesuré sur la même trace. Un ratio réduit la sensibilité à la vitesse absolue
d'une machine, il ne l'élimine pas. Un résultat se lit donc comme conditionné par
l'hôte qui l'a produit.

## Ce qui n'est pas permis

Un résultat surprenant, lent, bruité ou défavorable est un **fait à rapporter**.
Ce n'est jamais une autorisation à modifier un paramètre gelé, à rejouer jusqu'à
obtenir mieux, ni à retenir la plus flatteuse de plusieurs exécutions.
