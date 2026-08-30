# Où placer le cache par rapport à la frontière d'autorisation ?

## Contexte du système

Un service de documents mono-processus. Chaque document a un propriétaire et un
ensemble d'étiquettes. Chaque lecteur détient un ensemble de droits. Un lecteur
peut voir un document si :

```text
visible  ⟺  le lecteur possède le document
         ∨  ses droits croisent les étiquettes du document
```

Un unique point d'entrée en lecture répond à : « liste les documents appariés à
cette requête, que je suis autorisé à voir ». Il rend des identifiants et des
titres.

Tout s'exécute dans un seul processus, contre un magasin en mémoire. Ni réseau,
ni base de données, ni serveur de cache externe. Les étiquettes gouvernent la
visibilité et ne sont pas indexables : une mutation d'étiquette est une mutation
d'autorisation pure, une écriture de corps une mutation de contenu pure.

## Besoin

Ce listing est la vue d'accueil de l'application. Il est demandé à chaque
chargement de page, par chaque lecteur, plusieurs fois par session.

## Comportement actuel

Aucun cache. Chaque requête reparcourt l'ensemble des documents candidats, en
recalcule la projection de recherche — analyse, normalisation, découpage en
jetons — puis réapplique la règle de visibilité. La correction est triviale ; le
travail est intégralement refait à chaque requête, y compris lorsque rien n'a
changé et lorsque le même lecteur pose deux fois la même question.

## Espace de décision

La question n'est pas *s'il faut* cacher, mais **où placer le cache par rapport
à la frontière d'autorisation**. Trois placements sont défendables, et chacun est
une pratique courante quelque part :

1. au-dessus de la frontière, par lecteur ;
2. au-dessus de la frontière, par classe d'équivalence de droits, avec une
   surcouche propre au lecteur pour ce qu'il possède ;
3. sous la frontière, au niveau de la projection de document, le filtre
   d'autorisation étant réexécuté à chaque requête.

Ils sont décrits dans `architecture-options.md`, sans classement.

## Les axes qui s'opposent

### Latence

Le listing est sur le chemin critique de chaque chargement de page. Un objectif
chiffré est posé dans `requirements.md`, exprimé en rapport au p95 de la
référence non cachée mesurée sur la même trace.

### Fraîcheur de contenu

Un lecteur doit observer sa propre écriture à sa lecture suivante. Une écriture
validée doit être observée par tout lecteur affecté et autorisé à sa lecture
pertinente suivante — un lecteur non autorisé devant continuer à ne rien voir.

### Autorisation et isolation

Une lecture ne doit jamais rendre un document que le lecteur n'a pas le droit de
voir, y compris immédiatement après une révocation de droit, un transfert de
propriété ou un changement d'étiquette. C'est la seule contrainte dure de
visibilité. Elle n'élimine aucune des trois options : les trois peuvent la
satisfaire, et elles diffèrent par la machinerie que leur correction exige.

### Coût des mutations

La fraîcheur ne s'obtient pas gratuitement : ce qu'on ne paie pas en lecture, on
le paie en écriture. Chaque nature de mutation — contenu, étiquette, droit,
propriété — impose un travail d'invalidation qui diffère selon le placement, et
qui peut porter sur un très petit ou sur un très grand nombre d'entrées.

### Résidence et inspectabilité

Le nombre d'entrées retenues doit rester borné et exprimable en fonction d'une
quantité dénombrable. Séparément, une personne d'astreinte doit pouvoir
reconstituer pourquoi un résultat caché a été employé, à partir de métadonnées
inspectables et de la règle d'autorisation documentée — sans dépendre d'un état
caché opaque. Les trois placements n'enregistrent pas les mêmes métadonnées, et
n'ont pas à enregistrer les mêmes.

## Ce qui détermine la réponse

Lequel de ces axes domine est une propriété de la charge et du déploiement, non
des stratégies. Des variables susceptibles de compter, sans qu'aucune ne soit
déclarée dominante à l'avance :

```text
densité des classes de droits
densité de propriété
répétition et localité des requêtes
coût relatif de la matérialisation
coût relatif du filtrage d'autorisation vivant
rapport lectures / écritures
profil de mutation — contenu, étiquette, droit, propriété
population et résidence du cache au fil de l'historique de la charge
```

```text
QUELLES CARACTÉRISTIQUES DOMINENT DANS CETTE FIXTURE
    = MESURÉ / OBSERVÉ ENSUITE  +  INTERPRÉTÉ PAR UNE PERSONNE
    ≠ PRÉDÉCIDÉ
```

## Ce que la fixture fournit

- une implémentation de référence sans cache, qui sert d'oracle ;
- les trois stratégies, réellement implémentées ;
- une suite de qualification déterministe ;
- un banc d'essai reproductible, balayant deux paramètres déclarés.

## Ce que la fixture ne fournit pas

Ni recommandation, ni classement, ni score, ni vainqueur. Plusieurs arbitrages
demeurent défendables après connaissance de tous les faits déterministes, et les
départager demande un jugement humain que la fixture ne rend pas à sa place.
