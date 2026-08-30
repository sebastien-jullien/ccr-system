# Banc d'essai qualifié — rapport curé

Ce document rapporte les mesures de la **seule exécution qualifiée** du banc
d'essai.

Tous les chiffres rapportés sont **transcrits** du banc qualifié et **vérifiés**
contre `generated/benchmark.json`, produit par `bench/run-bench.mjs`. Aucun n'est
estimé ni inventé.

Ce fichier n'est pas engendré automatiquement : c'est une **transcription
éditoriale**. La source fait autorité sur les valeurs ; la sélection, le cadrage
et les réserves relèvent de la rédaction.

---

## 1. Statut de qualification

```text
SOURCE QUALIFIÉE   =  banc de recouvrement
PREMIER BANC       =  historique / non qualifiant, conservé pour la traçabilité
SÉLECTION PAR LA VALEUR  =  aucune
```

Le banc de recouvrement a été exécuté après le gel humain des règles P1 et P2, la
réparation ciblée limitée à ces deux règles, et une qualification déterministe
complète de la fixture. Le premier banc lui est antérieur ; ses valeurs
n'apparaissent nulle part dans ce document. La provenance est détaillée au § 10.

| | |
|---|---|
| Tests de la fixture | **75 / 75 PASS · 0 FAIL · code de sortie 0** |
| SHA-256 du corpus | `7e42e59ab35952e479f799077f82654a4df0bedc13bf1181ad949f4b17edfcb2` |
| Code de sortie du banc | **0** |
| Durée totale | **351,9 s** |

---

## 2. Périmètre expérimental

```text
documents             400
lecteurs              400
jetons par corps       96   (1 topic + 1 facette + 94 remplisseurs)
requêtes canoniques    32   (8 topics × 4 facettes, conjonctives)
classes de droits       4 · 40 · 400
densité de propriété   10 % · 35 % · 70 %
graines de charge       1 · 2 · 3

traces configurées     27   (3 × 3 × 3)
rejeux totaux         108   (27 traces × 4 stratégies)
rejeux S3              27
```

Chaque rejeu s'exécute dans un processus Node neuf, à partir d'un état initial
reconstruit intégralement. Le démarrage du processus, le chargement de la fixture
et le décodage de la trace sont hors chronométrage.

```text
échauffement     200 opérations, écartées
mesure         2 000 opérations
lectures mesurées par rejeu   1 900
bloc de 100 opérations    95 lectures + 5 mutations, une de chaque nature
```

L'ordre de rejeu des quatre stratégies tourne à gauche de `ordinal mod 4`, de
sorte qu'aucune stratégie n'occupe systématiquement la même position.

Chronométrage d'une lecture : départ immédiatement avant l'invocation logique,
arrêt immédiatement après l'existence du résultat ordonné complet. Percentiles
par rang le plus proche, sans interpolation.

---

## 3. Contexte d'hôte

```text
node_version    v22.18.0
platform        win32
arch            x64
cpu_model       AMD Ryzen 7 5800X 8-Core Processor
logical_cores   16
```

Ni nom de machine, ni nom d'utilisateur, ni répertoire personnel, ni
environnement ne sont enregistrés.

Toute valeur de latence de ce document est **conditionnée par cet hôte**.

---

## 4. Qualification déterministe

Exécutée avant le banc, et indépendante de lui : **75 tests, 75 succès, 0 échec,
code de sortie 0**.

Ces vérifications sont des propriétés, non des mesures. Elles ne dépendent ni de
la machine, ni de l'instant, ni de la charge.

| Domaine | Ce qui est établi |
|---|---|
| Génération | corpus reproductible à l'octet ; 96 jetons par corps ; vocabulaires disjoints ; `base_label` stable et octroyable ; propriété initiale bijective |
| Topologie | vecteurs d'incidence conformes aux préfixes 4 / 40 / 400 ; classes imbriquées, distinctes, de taille 5 ; sérialisation canonique injective et indépendante de l'ordre |
| Densité | ensembles « propriété seule » imbriqués — 40 ⊂ 140 ⊂ 280 ; `base_label` intact sous la surcouche de confidentialité |
| Trace | squelette déterministe ; consommation des tirages redérivée indépendamment ; 1 900 lectures mesurées ; 27 traces énumérées dans l'ordre gelé |
| Oracle | la REFERENCE égale un oracle ensembliste indépendant sur une matrice lecteur × requête |
| Stratégies | S1, S2 et S3 égalent la REFERENCE sur trois configurations, à froid comme à chaud |
| Visibilité | propriété seule, droits seuls, les deux bases avec déduplication |
| Autorisation | ajout de droit, révocation, transfert de propriété, étiquette visible → interdite et interdite → visible : aucune visibilité interdite périmée |
| Fraîcheur | contenu non apparié → apparié et apparié → non apparié, pour les trois stratégies, lecteur autorisé et lecteur non autorisé |
| Classes dormantes | invalidation de S2 sur contenu et sur étiquette, dans les deux directions, alors qu'aucun lecteur n'occupe la classe |
| S3 | équivalence projection cachée / fraîche ; jamais de réutilisation après changement de version ; loi de résidence |
| Projection | forme gelée `{ id, tokens, title, snippet }`, séquence complète, répétitions conservées |
| Normalisation | exactement une par lecture logique, avant consultation de cache, pour les quatre chemins |

---

## 5. Résultat R1

**Objectif** : médiane des ratios p95 par graine **≤ 0,40** (`0.40` dans la
notation machine du banc), le ratio étant le p95 d'une stratégie divisé par le
p95 de la REFERENCE **de la même trace**.

Valeurs ci-dessous : **médiane / min / max** sur les trois graines de charge.

Les tableaux de ce document reproduisent les valeurs **littérales du banc**, avec
le point décimal de la sortie machine ; la prose environnante suit la virgule
décimale française. Aucune valeur n'est reconvertie d'une notation à l'autre.

| classes | propriété | S1 | S2 | S3 |
|--:|--:|:--|:--|:--|
| 4 | 10 % | 1.010 / 0.888 / 1.252 | 0.882 / 0.817 / 0.981 | **0.059** / 0.049 / 0.062 |
| 4 | 35 % | 0.910 / 0.876 / 1.135 | 0.927 / 0.785 / 1.176 | **0.057** / 0.057 / 0.060 |
| 4 | 70 % | 0.905 / 0.819 / 0.951 | 0.863 / 0.832 / 0.892 | **0.055** / 0.044 / 0.061 |
| 40 | 10 % | 0.947 / 0.762 / 1.020 | 0.949 / 0.777 / 1.218 | **0.054** / 0.054 / 0.067 |
| 40 | 35 % | 0.912 / 0.868 / 0.987 | 0.884 / 0.877 / 1.003 | **0.056** / 0.049 / 0.061 |
| 40 | 70 % | 1.056 / 0.985 / 1.130 | 0.985 / 0.902 / 1.142 | **0.053** / 0.041 / 0.062 |
| 400 | 10 % | 0.873 / 0.855 / 0.956 | 0.970 / 0.907 / 1.073 | **0.054** / 0.051 / 0.057 |
| 400 | 35 % | 0.976 / 0.904 / 1.025 | 0.979 / 0.943 / 1.035 | **0.061** / 0.047 / 0.065 |
| 400 | 70 % | 0.975 / 0.915 / 1.037 | 1.003 / 0.978 / 1.062 | **0.051** / 0.051 / 0.055 |

**Configurations atteignant l'objectif :**

```text
S1   0 / 9
S2   0 / 9
S3   9 / 9
```

> Dans ce dispositif expérimental gelé, avec cette charge de travail et ces
> implémentations, S3 est la seule des trois stratégies testées à satisfaire
> l'objectif R1 dans chacune des neuf configurations mesurées.

**Cela n'établit pas que S3 soit universellement supérieure.** La portée de cet
énoncé s'arrête à cette fixture, cette charge, ces implémentations et cet hôte.

Pour situer les ordres de grandeur : le p95 de la REFERENCE s'étend de 2 730 µs à
3 547 µs selon la trace ; celui de S3, de 134 µs à 194 µs.

---

## 6. Observations sur les mutations

540 occurrences de chaque nature, par stratégie — 20 par rejeu mesuré, sur
27 rejeux.

**Agrégation des deux colonnes de durée.** Pour chaque rejeu qualifié, la
statistique de la nature de mutation est calculée sur ses propres occurrences ;
le tableau rapporte ensuite la **médiane de ces 27 valeurs par rejeu**. La
colonne `p95` est donc une **médiane de 27 valeurs de p95 par rejeu**, et non un
p95 global calculé sur les 540 occurrences. Durées en microsecondes.

La colonne « entrées invalidées » suit une autre règle : elle est le **cumul** des
entrées invalidées sur les 27 rejeux, tel que le rapporte le JSON qualifié.

| stratégie | mutation | n | médiane | p95 | entrées invalidées |
|:--|:--|--:|--:|--:|--:|
| REFERENCE | CONTENT_MEMBERSHIP_WRITE | 540 | 23.3 | 42.3 | 0 |
| REFERENCE | CONTENT_FILLER_WRITE | 540 | 35.7 | 63.9 | 0 |
| REFERENCE | LABEL_MUTATION | 540 | 35.6 | 71.0 | 0 |
| REFERENCE | GRANT_MUTATION | 540 | 194.0 | 374.1 | 0 |
| REFERENCE | OWNERSHIP_MUTATION | 540 | 50.6 | 126.1 | 0 |
| S1 | CONTENT_MEMBERSHIP_WRITE | 540 | 59.3 | 117.5 | 9 024 |
| S1 | CONTENT_FILLER_WRITE | 540 | 70.4 | 131.3 | 9 959 |
| S1 | LABEL_MUTATION | 540 | 104.1 | 175.6 | 30 581 |
| S1 | GRANT_MUTATION | 540 | 188.7 | 350.0 | 107 |
| S1 | OWNERSHIP_MUTATION | 540 | 51.6 | 119.4 | 101 |
| S2 | CONTENT_MEMBERSHIP_WRITE | 540 | 57.0 | 98.1 | 8 794 |
| S2 | CONTENT_FILLER_WRITE | 540 | 73.6 | 112.3 | 9 531 |
| S2 | LABEL_MUTATION | 540 | 79.1 | 134.4 | 24 597 |
| S2 | GRANT_MUTATION | 540 | 183.4 | 329.3 | **0** |
| S2 | OWNERSHIP_MUTATION | 540 | 50.5 | 142.0 | 2 526 |
| S3 | CONTENT_MEMBERSHIP_WRITE | 540 | 8.3 | 22.8 | 0 |
| S3 | CONTENT_FILLER_WRITE | 540 | 22.5 | 44.5 | 0 |
| S3 | LABEL_MUTATION | 540 | 17.8 | 41.2 | 0 |
| S3 | GRANT_MUTATION | 540 | 248.6 | 615.2 | 0 |
| S3 | OWNERSHIP_MUTATION | 540 | 34.5 | 88.2 | 0 |

**Fait notable.** S2 a invalidé **0 entrée** sur l'ensemble des mutations de droit
mesurées. C'est le comportement attendu sous la règle de réacheminement gelée :
un lecteur changeant d'ensemble de droits se réachemine entre classes canoniques
à sa lecture suivante, sans qu'aucune entrée partagée ne soit purgée.

**Deux précautions de lecture.**

La durée d'une mutation ne mesure pas la qualité d'un cache : une part de ce
coût appartient à la couche d'état, indépendamment de toute invalidation. Ainsi
`GRANT_MUTATION` est la mutation la plus coûteuse pour les quatre chemins, **y
compris pour la REFERENCE (194,0 µs) et pour S3 (248,6 µs), qui n'effectuent
aucun travail de cache** — l'ensemble éligible se calcule en dérivant la classe
vivante des 400 lecteurs.

Un nombre d'entrées invalidées ne se compare pas d'une stratégie à l'autre comme
un coût : les entrées ne portent pas la même chose, et une population de cache
plus dense produit mécaniquement des purges plus nombreuses.

---

## 7. Observations de résidence

Nombres d'entrées, **médianes sur les 27 traces** de chaque stratégie.

| stratégie | après échauffement | pic | fin |
|:--|--:|--:|--:|
| REFERENCE | 0 | 0 | 0 |
| S1 | 52 | 161 | 79 |
| S2 | 226 | 1 579 | 1 577 |
| S3 | 400 | 400 | 400 |

**S3 a retenu exactement 400 projections dans chacun de ses 27 rejeux qualifiés**
— après échauffement, au pic et en fin de mesure. L'espace de clés étant celui
des identifiants de documents, la loi `résidentes ≤ documents` s'y vérifie comme
une égalité une fois chaque document lu.

```text
NOMBRE D'ENTRÉES  ≠  CONSOMMATION MÉMOIRE
```

Aucun classement mémoire n'est déduit de ce tableau. Une entrée S1 est une
réponse complète, une entrée Part-1 de S2 une réponse partagée, une entrée Part-2
une surcouche, une entrée S3 une projection : leurs charges utiles diffèrent, et
aucun octet n'a été mesuré.

---

## 8. Interprétation

La distinction est maintenue explicitement entre ce qui a été observé et ce qui
en est déduit.

### Observations

- Les ratios p95 de S1 et de S2 restent au voisinage de la référence non cachée,
  dans les neuf configurations mesurées.
- Les ratios p95 de S3 se situent approximativement entre **0,051 et 0,061** en
  médiane, à travers les configurations testées.
- S3 est la seule des trois à satisfaire l'objectif R1, et elle le satisfait dans
  les neuf configurations.
- S2 n'invalide aucune entrée sur mutation de droit.
- S3 retient un nombre d'entrées constant, indépendant du nombre de classes et de
  la densité de propriété.

### Interprétation prudente

La charge gelée produit une **réutilisation utile limitée pour les caches de
résultat orientés lecteur ou requête**, tandis que la **réutilisation de
projection de document reste élevée**. Les lectures se répartissent sur 400
lecteurs et 32 requêtes pondérées, et cinq mutations par bloc de cent opérations
purgent largement ; à l'inverse, une projection est partagée par tous les
lecteurs et toutes les requêtes, et une écriture de contenu n'en périme qu'une.

Cette lecture est cohérente avec les nombres d'entrées invalidées et les
résidences observées. Elle **n'est pas** une mesure de taux de succès.

### Ce qui n'est pas affirmé

Aucun taux de succès de cache n'est avancé : **cette instrumentation n'existe
pas**. Son absence est un manque de métrique documenté et non bloquant, signalé
avant l'exécution qualifiée et volontairement non comblé après coup — l'ajouter
aurait exigé une seconde exécution.

Aucune des observations ci-dessus ne dit qu'une stratégie est bonne ou mauvaise,
ni qu'une conception est préférable à une autre. Elles disent ce qui s'est passé
dans cette expérience.

---

## 9. Limites

Ces mesures sont :

- **spécifiques à cette fixture** — corpus, topologie et règle de visibilité gelés ;
- **spécifiques à cette charge** — squelette, distribution zipfienne, ratio
  95 lectures / 5 mutations, deux paramètres balayés ;
- **spécifiques à ces implémentations** — trois stratégies parmi d'autres
  conceptions possibles ;
- **conditionnées par la machine** — un ratio réduit la sensibilité à la vitesse
  absolue d'un hôte sans l'éliminer.

Les **trois graines de charge sont des répétitions descriptives**, non un
échantillon statistique de population : la médiane, le minimum et le maximum
rapportés décrivent une dispersion observée, et ne constituent pas un intervalle
de confiance.

Ne s'y trouve, en outre :

- aucune affirmation de capacité en production ;
- aucun classement universel de stratégies de cache ;
- aucune métrique de taux de succès ;
- aucune comparaison de consommation mémoire en octets.

**Aucun fournisseur et aucun modèle n'a participé à la production de ces mesures
d'ingénierie.** Elles proviennent d'une exécution locale et déterministe.

Enfin, ces documents préparent des éléments de preuve pour un futur parcours CCR.
Ils ne rapportent aucune conclusion CCR : aucune controverse n'a été enregistrée,
aucun expert ne s'est prononcé, aucune décision humaine n'a été prise.

```text
ÉLÉMENT DE PREUVE D'INGÉNIERIE  ≠  DÉCISION CCR
```

---

## 10. Note de provenance

Deux exécutions réelles ont eu lieu. Les deux sont conservées ; une seule fait
autorité.

**Premier banc — historique, non qualifiant.** Exécution complète, terminée sans
erreur. Elle a précédé le gel humain de deux règles de calcul au niveau de
l'implémentation :

- **P1** — la forme de la projection matérialisée : `tokens` est la séquence
  complète des jetons normalisés du corps, et non un ensemble ;
- **P2** — le placement de la normalisation de requête : une fois par lecture
  logique, à l'intérieur du chronométrage, avant toute consultation de cache,
  identiquement pour les quatre chemins.

Ces deux écarts portaient sur le travail réellement mesuré. Les valeurs du
premier banc sont donc **inutilisables comme résultat qualifié**, et n'apparaissent
nulle part dans ce document.

Une copie de ses sorties est conservée à l'identique dans
`generated/first-benchmark/`. Cette copie est **locale**, **ignorée par Git**, et
**n'est pas garantie présente dans un clone public** : ce n'est pas un artefact
publié, et rien ici n'en exige la publication. La provenance durable est portée
par le présent énoncé, versionné avec la documentation, et non par ces octets.

**Banc de recouvrement — seule source qualifiée.** Exécuté dans cet ordre :

```text
1  gel humain de P1 et P2
2  réparation ciblée, limitée à ces deux règles
3  qualification déterministe de la fixture — 75 / 75 PASS, sortie 0
4  UNE exécution complète du banc — sortie 0, 351,9 s, 108 rejeux
```

Aucune sélection entre les deux exécutions n'a été faite sur la valeur des
résultats : le banc de recouvrement s'est achevé, donc ses mesures sont celles
qui font foi.

À énoncer clairement, puisque cela conditionne la lecture de tout ce document :
**le protocole affectant les résultats n'était pas intégralement gelé avant la
toute première exécution.** Il l'était avant l'exécution qualifiée.
