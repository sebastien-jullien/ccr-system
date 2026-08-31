# Showcase — placement d'un cache par rapport à la frontière d'autorisation

Fixture publique, autonome, sans dépendance. Elle pose un arbitrage d'ingénierie
réel, fournit les faits déterministes qui le contraignent, et s'arrête là.

Elle reste intégralement utile **sans aucun modèle de langage** : une personne
compétente peut exécuter les tests, exécuter le banc d'essai, lire les trois
options et se retrouver devant exactement le même arbitrage.

---

## 1. Ce que la fixture démontre

Un service de documents mono-processus. Chaque document a un propriétaire et un
ensemble d'étiquettes ; chaque lecteur détient un ensemble de droits.

```text
visible  ⟺  le lecteur possède le document
         ∨  ses droits croisent les étiquettes du document
```

Un unique point d'entrée en lecture répond à : « liste les documents appariés à
cette requête, que je suis autorisé à voir ». Sans cache, chaque requête
reparcourt les documents candidats, recalcule leur projection de recherche —
analyse, normalisation, découpage en jetons — puis réapplique la règle de
visibilité.

La question n'est pas *s'il faut* cacher, mais **où placer le cache par rapport
à la frontière d'autorisation**.

## 2. La tension d'ingénierie

Le placement fixe simultanément, et dans des directions opposées :

```text
latence de lecture
coût d'une écriture
délai d'effet d'un changement de droits ou de propriété
nombre d'entrées retenues
capacité d'une personne d'astreinte à expliquer ce qui est stocké
```

Aucun placement ne domine par construction sur l'ensemble de ces cinq dimensions :
elles ne désignent pas, à elles seules, un placement unique. Les exigences
viennent de quatre positions distinctes — produit, sécurité, plateforme,
astreinte — et aucune n'ordonne les autres. `requirements.md` les énonce
précisément, avec leur origine et leur méthode de mesure.

Lequel de ces axes domine est une propriété de la charge et du déploiement, non
des stratégies.

## 3. Les trois stratégies

| | Unité cachée | Clé |
|---|---|---|
| **S1** | la réponse finie, déjà filtrée | `(lecteur, requête)` |
| **S2** | Part-1 la réponse visible par droits, partagée · Part-2 la surcouche de propriété | `(classe de droits, requête)` · `(lecteur, requête)` |
| **S3** | la projection de recherche d'un document | `document_id` |

S1 et S2 placent le cache **au-dessus** de la frontière d'autorisation, S3
**en dessous**, le filtre étant réexécuté à chaque lecture. `architecture-options.md`
les décrit symétriquement, sans classement.

## 4. Deux natures de preuve, à ne pas confondre

```text
PREUVE DE CORRECTION DÉTERMINISTE   ≠   PREUVE DE PERFORMANCE
```

**Correction.** Chaque stratégie est comparée, élément par élément et dans
l'ordre, au **même oracle non caché**, sur une matrice lecteur × requête et après
chaque nature de mutation. Ce sont des propriétés : elles ne dépendent ni de la
machine, ni de l'instant, ni de la charge. Elles se rejouent à l'identique.

**Performance.** Les latences proviennent d'une **exécution**, sur une machine
donnée, sous une charge donnée. Elles sont conditionnées par cet hôte et par ce
squelette de charge, et ne se transposent pas telles quelles.

Un lecteur qui confondrait les deux tirerait d'une mesure ponctuelle une
conclusion que seule la première catégorie autorise.

## 5. Exécuter les tests

Node 22.18 ou plus récent. Aucune dépendance à installer.

```bash
npm test
```

La suite couvre la génération du corpus et de la topologie, la consommation
exacte des tirages, l'équivalence des trois stratégies avec l'oracle, la
fraîcheur de contenu dans les deux directions, les quatre natures de mutation
d'autorisation, la correction des classes dormantes de S2, la loi de résidence de
S3, et la forme gelée de la projection.

## 6. Exécuter le banc d'essai

```bash
npm run bench
```

27 traces configurées × 4 rejeux = 108 processus Node neufs. Les sorties brutes
sont écrites dans `observations/generated/`, **ignoré par Git** : aucun artefact
brut d'exécution n'est versionné.

Les mesures qualifiées, elles, figurent bien dans la documentation versionnée :
`observations/qualified-benchmark.md` est le **rapport curé** de l'exécution
qualifiée — une couche de documentation, distincte des artefacts bruts qu'elle
transcrit.

## 7. Où lire les observations qualifiées

```text
observations/README.md              provenance et statut des exécutions
observations/qualified-benchmark.md rapport curé de la SEULE exécution qualifiée
```

`observations/generated/` contient des sorties brutes d'exécution, régénérées à
chaque lancement. Ce n'est pas la couche d'interprétation publique.

## 8. Portée et limites

Ce que la fixture établit vaut **pour cette fixture**. Ne s'y trouve :

- aucune recommandation, aucun score, aucun classement, aucun vainqueur ;
- aucune affirmation de capacité en production ;
- aucun classement universel de stratégies de cache ;
- aucune mesure de consommation mémoire en octets — les nombres d'entrées ne
  sont pas des octets ;
- aucun taux de succès de cache : cette instrumentation n'existe pas, et son
  absence est un manque documenté, non comblé après coup.

Les trois graines de charge sont des **répétitions descriptives**, non un
échantillon statistique de population.

Choisir l'arbitrage final demande un jugement humain, que les faits
déterministes contraignent sans le remplacer.

## 9. Traversée exécutée

Cette fixture a servi de sujet à une traversée CCR réelle — le run canonique
`CCR-20260830-001` : deux experts, les mêmes paquets à l'octet près, une
contre-revue croisée, une controverse enregistrée, une décision humaine.

Le compte rendu est un **extrait curé** ; le run brut n'est pas versionné ici :
[`walkthrough/run-CCR-20260830-001.md`](walkthrough/run-CCR-20260830-001.md).

Tout ce qui précède reste exécutable sans appeler aucun modèle.
