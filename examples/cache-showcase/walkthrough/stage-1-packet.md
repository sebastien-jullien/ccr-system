# Paquet — première position

Ce document est le **matériau formellement fourni** pour cette première étape.
Il contient l'énoncé du problème, les exigences, les trois conceptions
envisagées, et un ensemble borné de faits déterministes établis hors ligne.

---

## Avis d'étape

Des mesures empiriques qualifiées existent et seront formellement fournies dans
une étape ultérieure.

Pour cette première position, raisonnez à partir du matériau explicitement
fourni ici.

Si vous consultez ou utilisez d'autres matériaux du workspace, signalez-le
explicitement dans votre réponse.

---

## Mandat

Vous êtes un expert en ingénierie logicielle. Il vous est demandé de produire une
position raisonnée sur l'arbitrage présenté.

Vous pouvez :

- privilégier une stratégie ;
- rendre une position conditionnelle ;
- ou conclure que le matériau fourni est insuffisant pour trancher.

Aucune de ces trois issues n'est préférée aux autres.

Distinguez explicitement, pour chaque affirmation de fond :

```text
FACT        ce qui est établi par le matériau fourni
INFERENCE   ce que vous en déduisez
JUDGMENT    ce que vous arbitrez, sans que le matériau le détermine
```

Un accord avec un autre expert n'établirait aucune vérité, et un désaccord n'est
ni attendu ni requis.

---

## Format de réponse

Répondez selon ce schéma, dans cet ordre :

```text
POSITION                 une stratégie, une composition, une position
                         conditionnelle, ou « matériau insuffisant »
CONDITIONS               ce sous quoi votre position tient
ASSUMPTIONS              ce que vous tenez pour acquis sans que ce soit établi ici
STRONGEST SUPPORT        l'élément qui soutient le plus votre position
STRONGEST COUNTERARGUMENT  le meilleur argument contre votre propre position
UNRESOLVED               ce que vous ne pouvez pas trancher avec ce matériau
WOULD CHANGE IF          le fait qui vous ferait changer d'avis
```

Le choix d'une stratégie unique n'est pas obligatoire.

---

---

# Énoncé du problème

*Source : `mission.md`, intégrée sans modification.*

---

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

---

# Exigences

*Source : `requirements.md`, intégrée sans modification.*

---

# Exigences

Six exigences, issues de quatre positions distinctes. Elles ne proviennent pas
d'une même autorité, et aucune n'ordonne les autres.

**R3 est la seule contrainte dure de visibilité, et elle n'élimine aucune
stratégie** : les trois la satisfont. Elles diffèrent par la machinerie que leur
correction exige. R3 tarife les options ; elle n'en choisit aucune.

---

## R1 — Latence

> Sous la charge de référence, le p95 de la lecture de listing doit valoir
> **≤ 40 % du p95 de la référence non cachée**, soit une réduction d'au moins
> 60 %.

- **Nature** : objectif souple, avec cible explicite.
- **Demandée par** : responsable produit.
- **Mesure** : `bench/run-bench.mjs`, même charge, même graine.

**Forme exacte de la qualification.** Pour une trace configurée, le ratio est le
p95 de la stratégie divisé par le p95 de la REFERENCE **de cette même trace**.
Une configuration — un nombre de classes croisé avec une densité de propriété —
comporte trois traces, une par graine de charge. L'objectif porte sur la
**médiane des trois ratios p95 par graine** :

```text
R1 satisfaite pour une configuration  ⟺  médiane des ratios p95 par graine ≤ 0.40
```

Les valeurs minimale et maximale des trois graines sont rapportées à côté de la
médiane, comme dispersion observée et non comme intervalle de confiance.

```text
40 %  =  cible d'auteur pour ce showcase, posée avant toute mesure
      =  volontairement exigeante, pour que les différences entre les trois
         stratégies soient observables dans la démonstration
      ≠  seuil universel de perceptibilité par un utilisateur
      ≠  vérité indépendante du matériel
```

Un ratio réduit la sensibilité à la vitesse absolue de la machine, il ne
l'élimine pas : tailles de cache, bande passante mémoire, allocation et
compilation à la volée affectent la référence et les stratégies différemment. Le
banc rapporte donc la machine, et tout ratio se lit comme conditionné par elle.

---

## R2a — Lecture de ses propres écritures

> Un lecteur doit observer sa propre écriture validée à sa lecture suivante.

- **Nature** : contrainte dure.
- **Demandée par** : responsable produit.
- **Mesure** : `tests/freshness.test.mjs`.

L'écriture s'achève au tic `t` ; la lecture suivante a lieu au tic `t+1`.

---

## R2b — Fraîcheur de contenu entre lecteurs

> Après validation d'une écriture de contenu seul sur le document D, **tout
> lecteur affecté** actuellement autorisé à observer D doit observer le résultat
> de requête mis à jour à sa lecture pertinente suivante. Un lecteur non
> autorisé à D doit continuer à ne pas l'observer.

- **Lecteur affecté** : lecteur `v` tel que `owner(D) = v ∨ grants(v) ∩ labels(D) ≠ ∅`,
  évalué sur l'état vivant. Une écriture de contenu seul ne modifiant ni le
  propriétaire ni les étiquettes, cet ensemble est le même avant et après.
- **Borne de péremption de contenu** : **0 opération achevée après validation**.
  La première lecture pertinente postérieure reflète déjà l'écriture.
- **Nature** : contrainte dure.
- **Demandée par** : responsable produit.
- **Mesure** : `tests/freshness.test.mjs`.

La borne nulle est un choix délibéré : toute fenêtre non nulle exigerait un
ordonnanceur, dont la granularité avantagerait silencieusement la stratégie
qu'elle arrange. À zéro, la fraîcheur ne coûte rien en lecture et tout en
écriture — où le banc la mesure ouvertement.

---

## R3 — Isolation

> Une lecture ne doit jamais rendre un document que le lecteur n'a pas le droit
> de voir — y compris immédiatement après la révocation d'un droit.

- **Nature** : **contrainte dure**.
- **Demandée par** : sécurité / conformité.
- **Mesure** : `tests/authorization.test.mjs`, `tests/oracle.test.mjs`,
  `tests/strategies.test.mjs`, `tests/dormant-class.test.mjs` — chaque résultat
  comparé élément par élément au même oracle non caché.

Mutations affectant l'autorisation : ajout de droit, révocation de droit,
changement de propriétaire, changement d'étiquette gouvernant la visibilité.
Après validation d'une telle mutation, la lecture suivante égale l'oracle.
L'autorisation n'est jamais placée derrière une cohérence à terme.

---

## R4 — Entrées bornées et dénombrables

> Le nombre d'entrées résidentes doit rester borné, et la borne doit s'exprimer
> en fonction d'une quantité dénombrable.

- **Nature** : objectif souple.
- **Demandée par** : plateforme / exploitation.
- **Mesure** : `tests/strategies.test.mjs`, et le banc, qui rapporte un nombre
  d'entrées — jamais une estimation.

Bornes d'espace de clés, dérivables par dénombrement et sans mesure :

```text
S1  ≤ lecteurs × requêtes
S2  ≤ (classes × requêtes) + (lecteurs × requêtes)
S3  ≤ documents
```

```text
BORNE D'ESPACE DE CLÉS
    ≠ POPULATION EFFECTIVE
    ≠ NOMBRE D'ENTRÉES RÉSIDENTES
    ≠ CONSOMMATION MÉMOIRE
```

Le rapport entre les populations réelles de S1 et de S2 dépend des requêtes
réellement exécutées, des classes réellement sollicitées, des surcouches non
vides et de l'historique de la charge. Il reste dépendant de la mesure.

---

## R5 — Rayon d'invalidation borné

> Une écriture de document doit invalider un ensemble d'entrées borné et
> énumérable.

- **Nature** : objectif souple.
- **Demandée par** : plateforme / exploitation.
- **Mesure** : le banc, métrique `entrées invalidées` par nature de mutation.

L'invalidation n'inspecte jamais ce qu'une entrée contenait auparavant : une
écriture peut faire passer un document de non apparié à apparié, et une règle
fondée sur l'appartenance antérieure manquerait précisément ce cas.

---

## R6 — Exploitabilité / explicabilité

> Une personne d'astreinte doit pouvoir reconstituer pourquoi un résultat ou un
> intermédiaire caché a été employé, à partir de métadonnées de cache
> inspectables et de la règle d'autorisation documentée, sans dépendre d'un état
> caché opaque.

- **Nature** : objectif souple.
- **Demandée par** : astreinte / exploitation.
- **Mesure** : inspection des métadonnées déclarées par chaque stratégie.

| | Métadonnées inspectables | Contexte d'autorisation | Version / portée |
|---|---|---|---|
| **S1** | `viewer`, `requête` | l'identité du lecteur, dans la clé | — |
| **S2 Part-1** | classe de droits, **liste triée en clair** | l'ensemble de droits, littéralement dans la clé | — |
| **S2 Part-2** | `viewer`, `requête` | l'identité du lecteur | — |
| **S3** | `document_id`, `content_version` | **aucun, par construction** | version de contenu |

Les schémas ne sont pas identiques, et n'ont pas à l'être. Une liste de droits
lisible n'est pas intrinsèquement inférieure à un identifiant de lecteur : ce
sont deux valeurs en clair nommant une entrée d'autorisation réelle. Pour S3,
l'absence de métadonnée d'autorisation **est** l'explication : rien de la
visibilité n'a été réutilisé.

---

## Tensions présentes avant tout modèle

| A | B | Pourquoi elles s'opposent |
|---|---|---|
| R1 latence | R3 isolation | la latence s'améliore quand le travail caché se partage ; le partage est ce qui rend une erreur de visibilité possible |
| R1 latence | R4 entrées résidentes | la façon la moins coûteuse de satisfaire R3 en gagnant en latence indexe une entrée par lecteur, donc fait croître la population d'entrées avec la population de lecteurs |
| R2b fraîcheur | R5 rayon d'invalidation | la fenêtre nulle s'achète entièrement sur le chemin d'écriture |
| R1 latence | plafond structurel de S3 | S3 ne cache que la projection ; l'appariement, le filtre et l'assemblage sont toujours réexécutés |
| partage de S2 | assemblage et double invalidation de S2 | les gains et les coûts de S2 croissent avec le même levier |
| densité de classes | densité de propriété | les deux paramètres tirent les deux régions de S2 dans des directions différentes |

```text
NOMBRE D'ENTRÉES  ≠  CONSOMMATION MÉMOIRE
```

La ligne `R1 / R4` porte sur une **population d'entrées dénombrable**, jamais sur
des octets : aucune consommation mémoire n'est mesurée par cette fixture, et
aucun classement mémoire entre S1, S2 et S3 n'en est déduit.

Ces tensions sont dans les fichiers et dans les tests. Elles restent ouvertes
tant que des éléments de preuve et un jugement humain explicite ne les tranchent
pas.

---

# Les trois placements du cache

*Source : `architecture-options.md`, intégrée sans modification.*

---

# Trois placements du cache

Description symétrique. Chaque stratégie est présentée sous les mêmes six
rubriques. Aucun classement, aucun score, aucune recommandation, et aucune
formulation dérivée d'une mesure : ce document décrit des conceptions, pas des
résultats.

Ordre de balayage commun aux quatre chemins — la référence non cachée comprise :

```text
MATÉRIALISER → APPARIER LA REQUÊTE → AUTORISER → ACCUMULER
```

L'autorisation ne décide jamais si le travail d'appariement est exécuté. La
normalisation de la requête a lieu une fois par lecture logique, avant toute
consultation de cache, et identiquement pour les quatre.

Ordre final du résultat : identifiants de documents croissants, pour les quatre.

---

## S1 — Cache de résultat par lecteur

*Au-dessus de la frontière d'autorisation, étroit.*

**Unité cachée** — la réponse finie, déjà filtrée pour un lecteur.

**Clé** — `(lecteur, requête)`.

**Chemin de lecture** — normaliser la requête ; consulter le cache ; en cas de
succès, rendre l'entrée ; en cas de manque, parcourir les documents, matérialiser,
apparier, autoriser, accumuler, stocker, rendre.

**Invalidation**

| mutation | effet |
|---|---|
| contenu | purger **toutes** les entrées de **tout** lecteur actuellement autorisé au document modifié |
| étiquette | purger les entrées de tout lecteur détenant l'ancienne ou la nouvelle étiquette |
| droit | purger les entrées des deux lecteurs échangés |
| propriété | purger les entrées de l'ancien et du nouveau propriétaire |

L'invalidation n'inspecte jamais ce qu'une entrée contenait : une écriture peut
faire passer un document de non apparié à apparié, et une règle fondée sur
l'appartenance antérieure manquerait précisément ce cas.

**Autorisation** — la clé `(lecteur, requête)` isole structurellement les
réponses entre lecteurs : une réponse cachée n'est rendue qu'au lecteur pour
lequel elle a été calculée. Après une mutation d'autorisation, la correction
dépend en revanche des invalidations synchrones décrites ci-dessus.

**Arbitrages attendus** — espace de clés `lecteurs × requêtes`, donc croissant
avec la population de lecteurs. Une première lecture ne bénéficie de rien. La clé
est deux valeurs littérales : la reconstitution d'un résultat par une personne
d'astreinte y lit directement l'identité du lecteur. Le plafond de latence est le
meilleur atteignable, puisque toute la réponse est cachée.

---

## S2 — Réponse partagée par classe de droits, avec surcouche de propriété

*Au-dessus de la frontière d'autorisation, décomposé le long des deux bases de la
visibilité.*

```text
oracle(v, q) = { d ∈ q : grants(v) ∩ labels(d) ≠ ∅ }   ← ne dépend que des droits
             ∪ { d ∈ q : owner(d) = v }                 ← ne dépend que de v
```

Le premier terme est une fonction de l'ensemble de droits seul : tout lecteur de
mêmes droits a exactement le même premier terme. Le second est irréductiblement
propre au lecteur. L'union est exacte, non approchée.

**Unité cachée** — deux unités distinctes : **Part-1**, la réponse visible par
croisement droits ∩ étiquettes, partagée entre lecteurs de même classe ;
**Part-2**, la surcouche des documents que ce lecteur possède.

**Clés** — `(classe de droits, requête)` pour Part-1, `(lecteur, requête)` pour
Part-2.

La classe de droits est une **sérialisation canonique lisible et décodable** de
l'ensemble de droits, redérivée des droits vivants à chaque lecture :

```text
grant_class = JSON.stringify([...grants].sort())
            → ["grant-00","grant-03","grant-05","grant-07","grant-10"]
```

Aucun condensat n'intervient : l'ensemble de droits figure littéralement dans la
clé, et `JSON.parse` le restitue. C'est ce qui permet à l'invalidation d'énumérer
l'espace de clés sans consulter aucun registre de lecteurs.

**Chemin de lecture** — normaliser la requête ; dériver la classe de droits ;
consulter les deux régions.

| état | travail |
|---|---|
| double succès | assembler, sans aucune traversée |
| manque simple | **une** traversée, produisant la seule région manquante |
| double manque | **une** traversée : une matérialisation et un appariement par document, puis les deux prédicats évalués indépendamment |

Une région en succès n'est jamais recalculée parce que l'autre a manqué. Un
résultat vide est une entrée cachée valide. L'assemblage est une union, une
déduplication par identifiant, puis l'ordre croissant.

**Invalidation**

| mutation | effet |
|---|---|
| contenu | énumérer les classes **RÉSIDENTES** depuis l'espace de clés de Part-1 ; purger celles dont les droits croisent les étiquettes du document ; puis purger Part-2 du propriétaire |
| étiquette | pour chaque classe résidente, purger si ses droits croisent l'**ancienne** ou la **nouvelle** étiquette |
| droit | aucune : le lecteur se réachemine entre classes canoniques à sa lecture suivante |
| propriété | purger Part-2 de l'ancien et du nouveau propriétaire ; Part-1 intacte |

```text
CLASSE ACTIVE  ≠  CLASSE RÉSIDENTE
```

Une entrée Part-1 survit à tous les occupants de sa classe. L'invalidation
énumère donc l'espace de clés résident, jamais les lecteurs actifs.

**Autorisation** — la propriété n'apparaît que dans Part-2, indexée par lecteur ;
Part-1 ne peut donc jamais gagner un document visible par propriété. La classe de
droits est redérivée des droits vivants à chaque lecture : une révocation
réachemine le lecteur vers une autre entrée, l'ancienne restant valide pour les
lecteurs qui y sont encore. Mémoïser cette classe au lieu de la recalculer
servirait, après révocation, l'entrée de son ancienne classe ; l'implémentation
la redérive donc à chaque lecture.

La redérivation vivante rend structurel le **réacheminement après changement de
droits**. La correction après **changement d'étiquette** et après **transfert de
propriété** repose, elle, sur les invalidations synchrones correspondantes
décrites ci-dessus — respectivement la purge des classes Part-1 résidentes
concernées, et celle des entrées Part-2 des deux propriétaires.

**Arbitrages attendus** — espace de clés
`(classes × requêtes) + (lecteurs × requêtes)`. Deux consultations et un
assemblage à chaque lecture, y compris en double succès. Deux domaines
d'invalidation aux déclencheurs distincts. En contrepartie, la moitié visible par
droits est calculée une fois par classe plutôt qu'une fois par lecteur ; ce que
cela vaut dépend de la densité des classes et de la densité de propriété.

---

## S3 — Cache de projection, sous la frontière

*Sous la frontière d'autorisation, le filtre étant réexécuté à chaque lecture.*

```text
BRUT
  ↓
MATÉRIALISATION / PROJECTION DE RECHERCHE          ← l'unité cachée
  analyser le corps · normaliser NFKC · minuscules · découper en jetons
  dériver la séquence de jetons, le titre, l'extrait
  ↓
FILTRE D'AUTORISATION VIVANT                       ← jamais caché
  ↓
RÉSULTAT
```

**Unité cachée** — la projection de recherche matérialisée d'un document.

**Clé** — `document_id`.

```text
document_id  →  { content_version, materialized_projection }
```

**Chemin de lecture** — normaliser la requête ; pour chaque document, lire sa
version de contenu vivante et consulter le cache : si la version cachée est égale
à la version vivante, réutiliser la projection ; sinon rematérialiser depuis le
corps brut et **remplacer la valeur en place**. Puis apparier, autoriser,
accumuler. Le remplacement est **paresseux** : il a lieu à la lecture suivante du
document, non à l'écriture.

**Invalidation**

| mutation | effet |
|---|---|
| contenu | aucune action de cache : la version canonique avance, la lecture suivante constate l'écart |
| étiquette | aucune |
| droit | aucune |
| propriété | aucune |

**Autorisation** — évaluée vivante à chaque lecture. Le cache ne contient rien de
la visibilité, donc aucune mutation d'autorisation ne peut le rendre périmé.

**Arbitrages attendus** — l'espace de clés est exactement l'espace des
identifiants de documents. Une écriture de contenu ne crée aucune nouvelle clé de
cache : si une projection est déjà résidente, elle est remplacée en place lors de
la prochaine lecture qui constate que `content_version` a changé. Le nombre de
projections résidentes ne peut donc dépasser le nombre de documents.

Aucun cache de résultat de requête n'existe : l'appariement, l'autorisation et
l'assemblage sont réexécutés à chaque lecture. Aucun gain supplémentaire n'est
attaché spécifiquement à la répétition d'une même paire `(lecteur, requête)` ; la
réutilisation porte sur les projections de documents, indépendamment du lecteur
et de la requête, tant que `content_version` n'a pas changé. Le gain porte donc
sur la matérialisation seule, et son plafond est la part de celle-ci dans le coût
total. Côté exploitation, la clé ne porte aucune métadonnée d'autorisation — et
cette absence est elle-même l'explication : rien de la visibilité n'a été
réutilisé.

---

# Faits déterministes établis hors ligne

Ces faits proviennent d'une suite de qualification déterministe exécutée hors
ligne. Ce sont des **propriétés**, non des mesures : elles ne dépendent ni de la
machine, ni de l'instant, ni de la charge, et se rejouent à l'identique.

## Échelle du dispositif

```text
documents                400
lecteurs                 400
jetons par corps          96   (1 topic + 1 facette + 94 remplisseurs)
requêtes canoniques       32   (8 topics × 4 facettes, appariement conjonctif)
étiquettes octroyables    11   + une étiquette « private », jamais octroyable
taille d'une classe        5   grants distincts parmi 11
```

Deux paramètres sont balayés par le dispositif expérimental :

```text
densité des classes de droits    4 · 40 · 400 classes pour 400 lecteurs
                                 soit 100 · 10 · 1 lecteur(s) par classe
densité de propriété             10 % · 35 % · 70 % de documents
                                 visibles par leur seul propriétaire
```

Aucun de ces deux paramètres n'est déclaré dominant.

## Équivalence des trois stratégies

Une implémentation de référence **sans cache** sert d'oracle. Chaque stratégie
est comparée à ce même oracle, élément par élément et dans l'ordre, sur une
matrice lecteur × requête et après chaque nature de mutation.

```text
S1, S2 et S3 rendent le MÊME résultat que l'oracle non caché.
```

La suite déterministe compte **75 tests, 75 succès, 0 échec, code de sortie 0**.
Elle établit notamment :

- la reproductibilité du corpus et de la topologie ;
- la visibilité par propriété seule, par droits seuls, et par les deux bases
  avec déduplication ;
- l'absence de visibilité interdite périmée après ajout de droit, révocation,
  transfert de propriété et changement d'étiquette ;
- la fraîcheur de contenu dans les deux directions — un document qui devient
  apparié, et un document qui cesse de l'être ;
- la correction de S2 lorsqu'une classe de droits n'a plus aucun occupant ;
- pour S3, l'équivalence entre projection cachée et projection fraîche, la
  non-réutilisation après changement de version, et la loi de résidence.

Aucune de ces vérifications ne mesure une durée.

## Ce qui n'est pas fourni à cette étape

Aucune mesure de latence, de coût de mutation ou de nombre d'entrées résidentes
n'est fournie ici. Ces mesures existent et seront formellement fournies à
l'étape suivante.
