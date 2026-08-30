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
