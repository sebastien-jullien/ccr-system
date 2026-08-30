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
