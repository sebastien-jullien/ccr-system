# Paquet — mesures empiriques qualifiées

Ce document est le **matériau formellement fourni** pour la seconde étape. Il
contient les mesures de la seule exécution qualifiée du banc d'essai, sous forme
de tables et de notes méthodologiques bornées.

Les mêmes octets sont fournis aux deux experts, à la même étape.

---

## 1. Statut de qualification

```text
SOURCE QUALIFIÉE   =  banc de recouvrement, exécution unique
CODE DE SORTIE     =  0
DURÉE TOTALE       =  351.9 s
```

Une exécution antérieure du banc existe. Elle a précédé l'achèvement et le gel de
deux règles de calcul au niveau de l'implémentation — la forme exacte de la
projection matérialisée, et le placement de la normalisation de requête. Ses
valeurs sont **inutilisables comme résultat qualifié** et n'apparaissent nulle
part dans ce document.

La qualification déterministe hors ligne — 75 tests, 75 succès, 0 échec, code de
sortie 0 — a été exécutée après ce gel et avant ce banc.

```text
SHA-256 du corpus  =  7e42e59ab35952e479f799077f82654a4df0bedc13bf1181ad949f4b17edfcb2
```

## 2. Périmètre expérimental

```text
traces configurées     27   (3 densités de classes × 3 densités de
                              propriété × 3 graines de charge)
rejeux totaux         108   (27 traces × 4 chemins mesurés)
rejeux par stratégie   27

échauffement          200 opérations, écartées
mesure              2 000 opérations
lectures mesurées   1 900 par rejeu
bloc de 100 opérations   95 lectures + 5 mutations, une de chaque nature
```

Chaque rejeu s'exécute dans un processus Node neuf, à partir d'un état initial
reconstruit intégralement. Le démarrage du processus, le chargement du dispositif
et le décodage de la trace sont hors chronométrage.

L'ordre de rejeu des quatre chemins tourne d'une position à chaque trace, de
sorte qu'aucun n'occupe systématiquement la même place.

Chronométrage d'une lecture : départ immédiatement avant l'invocation logique,
arrêt immédiatement après l'existence du résultat ordonné complet. Percentiles
par rang le plus proche, sans interpolation.

## 3. Contexte d'hôte

```text
node_version    v22.18.0
platform        win32
arch            x64
cpu_model       AMD Ryzen 7 5800X 8-Core Processor
logical_cores   16
```

Toute valeur de latence de ce document est conditionnée par cet hôte.

## 4. Définition exacte de R1

Pour une trace configurée, le ratio est le p95 de la stratégie divisé par le p95
de la REFERENCE **de cette même trace**.

Une configuration — un nombre de classes croisé avec une densité de propriété —
comporte trois traces, une par graine de charge. L'objectif porte sur la médiane
des trois ratios p95 par graine :

```text
R1 satisfaite pour une configuration  ⟺  médiane des ratios p95 par graine ≤ 0.4
```

Les valeurs minimale et maximale des trois graines décrivent une dispersion
observée. Ce n'est pas un intervalle de confiance.

La cible de 40 % est une cible d'auteur posée avant toute mesure. Ce n'est ni
un seuil universel de perceptibilité par un utilisateur, ni une vérité
indépendante du matériel.

## 5. Table R1 — médiane / min / max sur les trois graines

| classes | propriété | S1 | S2 | S3 |
|--:|--:|:--|:--|:--|
| 4 | 10 % | 1.010 / 0.888 / 1.252 | 0.882 / 0.817 / 0.981 | 0.059 / 0.049 / 0.062 |
| 4 | 35 % | 0.910 / 0.876 / 1.135 | 0.927 / 0.785 / 1.176 | 0.057 / 0.057 / 0.060 |
| 4 | 70 % | 0.905 / 0.819 / 0.951 | 0.863 / 0.832 / 0.892 | 0.055 / 0.044 / 0.061 |
| 40 | 10 % | 0.947 / 0.762 / 1.020 | 0.949 / 0.777 / 1.218 | 0.054 / 0.054 / 0.067 |
| 40 | 35 % | 0.912 / 0.868 / 0.987 | 0.884 / 0.877 / 1.003 | 0.056 / 0.049 / 0.061 |
| 40 | 70 % | 1.056 / 0.985 / 1.130 | 0.985 / 0.902 / 1.142 | 0.053 / 0.041 / 0.062 |
| 400 | 10 % | 0.873 / 0.855 / 0.956 | 0.970 / 0.907 / 1.073 | 0.054 / 0.051 / 0.057 |
| 400 | 35 % | 0.976 / 0.904 / 1.025 | 0.979 / 0.943 / 1.035 | 0.061 / 0.047 / 0.065 |
| 400 | 70 % | 0.975 / 0.915 / 1.037 | 1.003 / 0.978 / 1.062 | 0.051 / 0.051 / 0.055 |

Configurations dont la médiane atteint l'objectif :

```text
S1   0 / 9
S2   0 / 9
S3   9 / 9
```

Ordres de grandeur : le p95 de la REFERENCE s'étend de 2730 µs à 3547 µs
selon la trace ; celui de S3, de 134 µs à 194 µs.

## 6. Règle d'agrégation des mutations

540 occurrences de chaque nature, par stratégie — 20 par rejeu mesuré, sur
27 rejeux.

Pour chaque rejeu, la statistique de la nature de mutation est calculée sur ses
propres occurrences ; la table rapporte ensuite la **médiane de ces 27 valeurs par
rejeu**. La colonne `p95` est donc une médiane de 27 valeurs de p95 par rejeu, et
non un p95 global sur les 540 occurrences. Durées en microsecondes.

La colonne « entrées invalidées » suit une autre règle : c'est le **cumul** sur
les 27 rejeux.

## 7. Table des mutations

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
| S2 | GRANT_MUTATION | 540 | 183.4 | 329.3 | 0 |
| S2 | OWNERSHIP_MUTATION | 540 | 50.5 | 142.0 | 2 526 |
| S3 | CONTENT_MEMBERSHIP_WRITE | 540 | 8.3 | 22.8 | 0 |
| S3 | CONTENT_FILLER_WRITE | 540 | 22.5 | 44.5 | 0 |
| S3 | LABEL_MUTATION | 540 | 17.8 | 41.2 | 0 |
| S3 | GRANT_MUTATION | 540 | 248.6 | 615.2 | 0 |
| S3 | OWNERSHIP_MUTATION | 540 | 34.5 | 88.2 | 0 |

## 8. Table de résidence

Nombres d'entrées, médianes sur les 27 traces de chaque stratégie.

| stratégie | après échauffement | pic | fin |
|:--|--:|--:|--:|
| REFERENCE | 0 | 0 | 0 |
| S1 | 52 | 161 | 79 |
| S2 | 226 | 1 579 | 1 577 |
| S3 | 400 | 400 | 400 |

S3 a retenu exactement 400 projections dans chacun de ses 27 rejeux qualifiés —
après échauffement, au pic et en fin de mesure.

## 9. Limites des métriques

```text
NOMBRE D'ENTRÉES  ≠  CONSOMMATION MÉMOIRE
```

Aucun octet n'a été mesuré. Une entrée S1 est une réponse complète, une entrée
Part-1 de S2 une réponse partagée, une entrée Part-2 une surcouche, une entrée S3
une projection : leurs charges utiles diffèrent.

**Aucun taux de succès de cache n'a été instrumenté.** Cette métrique n'existe
pas dans ce banc, et aucune valeur de réutilisation n'est disponible.

La durée d'une mutation ne mesure pas la qualité d'un cache : une part de ce coût
appartient à la couche d'état, indépendamment de toute invalidation.

Un nombre d'entrées invalidées ne se compare pas d'une stratégie à l'autre comme
un coût : les entrées ne portent pas la même chose.

Ces mesures sont spécifiques à ce dispositif, à cette charge, à ces
implémentations, et conditionnées par cet hôte. Les trois graines de charge sont
des répétitions descriptives, non un échantillon statistique de population.

Aucune capacité en production n'est mesurée. Aucun classement universel de
stratégies de cache n'est établi.

## 10. Provenance

Les valeurs de ce document sont dérivées du rapport machine de l'exécution
qualifiée, et d'aucune autre source. Aucune n'est estimée. Aucune ne provient de
l'exécution antérieure non qualifiante.

Aucun fournisseur et aucun modèle n'a participé à la production de ces mesures :
elles proviennent d'une exécution locale et déterministe.

---

# Réévaluation demandée

À partir des mesures ci-dessus, reprenez votre position de la première étape et
indiquez si vous la **maintenez**, la **révisez**, la **restreignez** ou la
**qualifiez**.

Répondez selon ce schéma, dans cet ordre :

```text
POSITION                   votre position après lecture de ces mesures
CHANGED FROM INITIAL       ce qui a changé, ou « rien »
FACTS RELIED ON            les faits formellement fournis ici sur lesquels
                           vous vous appuyez pour cette évolution
CONDITIONS                 ce sous quoi votre position tient
ASSUMPTIONS                ce que vous tenez pour acquis sans que ce soit
                           établi ici
STRONGEST SUPPORT          l'élément qui soutient le plus votre position
STRONGEST COUNTERARGUMENT  le meilleur argument restant contre votre position
UNRESOLVED                 ce que vous ne pouvez toujours pas trancher
WOULD CHANGE IF            le fait supplémentaire qui vous ferait encore changer
```

Distinguez explicitement, pour chaque affirmation de fond :

```text
FACT        ce qui est établi par le matériau fourni
INFERENCE   ce que vous en déduisez
JUDGMENT    ce que vous arbitrez, sans que le matériau le détermine
```

`FACTS RELIED ON` désigne les faits formellement fournis dans ce document sur
lesquels vous vous appuyez pour l'évolution que vous rapportez. L'attribution
par un expert d'un changement à des faits fournis est une **attribution
rapportée par l'expert**, et non une relation causale établie par CCR.

Maintenir votre position est une issue aussi acceptable que la réviser. Le choix
d'une stratégie unique n'est pas obligatoire, et « matériau insuffisant » reste
une réponse complète.

Si vous consultez ou utilisez d'autres matériaux du workspace, signalez-le
explicitement dans votre réponse.
