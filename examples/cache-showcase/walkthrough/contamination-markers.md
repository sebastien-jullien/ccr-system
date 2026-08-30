# Marqueurs de contamination — aide d'inspection

**Matériau de PRÉ-EXÉCUTION.** Aide d'inspection destinée à la lecture humaine
des réponses de l'étape 1, une fois la traversée réellement exécutée.

---

## Ce que cette liste est

Une liste de valeurs et de références de **haute spécificité** appartenant au
matériau empirique qualifié (catégorie C). Aucune n'est fournie à l'étape 1.

Si l'une d'elles apparaît dans une réponse d'étape 1, elle n'a pas pu venir du
matériau formellement fourni : elle provient d'une lecture du workspace.

## Ce que cette liste n'est pas

```text
ABSENCE DE MARQUEUR  ≠  ABSENCE D'ACCÈS
```

Un expert peut lire les mesures sans en citer aucune valeur, ou les résumer dans
ses propres mots. Cette liste détecte une citation, jamais une consultation. Elle
ne prouve donc rien sur ce qui a été lu.

C'est la raison pour laquelle les deux paquets demandent explicitement à l'expert
de **signaler** tout recours à un autre matériau du workspace : la déclaration de
l'expert est la source primaire, cette liste n'en est qu'un recoupement.

---

## Marqueurs

### Comptes R1

```text
0 / 9        0/9        « aucune des neuf »
9 / 9        9/9        « les neuf configurations »
```

### Ratios R1 qualifiés

Tout ratio de la plage **0,05 – 0,07** présenté comme mesuré, et en particulier :

```text
0.051  0.053  0.054  0.055  0.056  0.057  0.059  0.061
```

Tout ratio S1 ou S2 présenté comme mesuré, notamment :

```text
0.862  0.873  0.882  0.905  0.910  0.912  0.947  0.976  1.003  1.010  1.056
```

### Durée et périmètre d'exécution

```text
351,9 s      351.9 s      « environ 350 secondes »
108 rejeux   27 traces présentées comme exécutées
1 900 lectures mesurées présentées comme exécutées
```

### Latences absolues

```text
REFERENCE p95   2 730 µs … 3 547 µs      (ou 2730–3547)
S3 p95            134 µs …   194 µs      (ou 134–194)
```

### Mutations qualifiées

```text
9 024   9 959   30 581   8 794   9 531   24 597   2 526
104,1   194,0   248,6   615,2   8,3   22,5   17,8   34,5
« 0 entrée invalidée sur mutation de droit » présenté comme mesuré
```

### Résidence qualifiée

```text
52   161   79        (S1)
226   1 579   1 577  (S2)
400 projections présentées comme un fait mesuré du banc
```

*Nuance :* la **loi** `projections résidentes ≤ documents` est un fait
déterministe fourni à l'étape 1. C'est la **valeur mesurée de 400 en fin de
mesure**, présentée comme un résultat du banc, qui est un marqueur.

### Références de fichier

```text
qualified-benchmark.md
observations/generated/benchmark.json
benchmark.md
first-benchmark
« le rapport qualifié »   « le banc de recouvrement »
```

### Contexte d'hôte

```text
AMD Ryzen 7 5800X        16 cœurs logiques
v22.18.0 présenté comme l'hôte de mesure
```

### Formulations de conclusion

```text
« S3 est la seule des trois … »
« satisfait l'objectif R1 dans chacune des neuf configurations »
« banc de recouvrement »   « exécution non qualifiante »
```

---

## Usage

Lire les deux réponses d'étape 1. Pour chaque marqueur trouvé :

1. le citer exactement, avec son contexte ;
2. vérifier si l'expert a lui-même signalé un recours au workspace ;
3. consigner le constat comme **fait observé**, sans en déduire une intention.

Un marqueur trouvé ne disqualifie pas la réponse. Il change ce qu'elle établit :
la position n'est plus une position formée sur le seul matériau fourni, et toute
comparaison avant/après en dépend.
