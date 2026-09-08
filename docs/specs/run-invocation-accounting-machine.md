# CCR — Spécification · Comptabilité machine des invocations d'un run

```text
STATUT                              contrat RATIFIÉ PAR L'HUMAIN
                                    avant la frontière · état 2-bis
                                    à compter d'elle · contrat courant, état 3
IMPLÉMENTATION                      PRÉSENTE DANS LA LIGNE DE BASE SOURCE
CONFORMITÉ DE CE CONTRAT            ÉTABLIE
VERSION DE PUBLICATION PRÉPARÉE     1.3.0
LIGNE DE BASE SUPPORTÉE             AUCUNE avant la frontière
                                    v1.3.0 à compter d'elle
PORTÉE                              comptabilité d'invocation machine publique · lecture seule
CONTRATS SÉMANTIQUES SUPPORTÉS      1
CONTRATS DE REPRÉSENTATION MACHINE  1
REPRÉSENTATION PAR DÉFAUT           1
```

Ce document définit la structure et la portée du document machine que produit
`ccr run-invocation-accounting <run_id> --format json`.

```text
FRONTIÈRE DE PUBLICATION
  =  la présence réussie, sur le remote canonique du dépôt, d'un tag
     `v1.3.0` qui soit un OBJET DE TAG ANNOTÉ et dont la CIBLE ÉPLUCHÉE
     soit exactement le commit de préparation v1.3.0 ratifié
     un tag léger, un tag annoté pointant ailleurs, ou un tag resté local
     ne la franchissent pas
     définition intégrale : compatibility.md § 3.4

AVANT LA FRONTIÈRE
  état 2-bis · aucune version publiée ne fournit la commande ci-dessus ·
  la version publiée courante est 1.2.0, et elle ne la contient pas
À COMPTER DE LA FRONTIÈRE
  état 3 · contrat public supporté · ligne de base supportée v1.3.0

AUTORITÉ NORMATIVE   ratifiée par l'humain
IMPLÉMENTATION       présente dans la ligne de base source
CONFORMITÉ           établie pour CE contrat · elle ne vaut pas vérification
                     complète du dépôt
```

Ce document énonce ce qu'une implémentation conforme rend, et une implémentation
conforme existe dans la ligne de base source. Son entrée dans le contrat public
supporté est datée par la frontière ci-dessus, et par elle seule : la présence
de ce texte dans Git ne la constitue pas.
Voir [`compatibility.md`](compatibility.md) § 3.4.

---

# 1. Autorité et portée

## 1.1 Ce que ce document possède

```text
LA POLITIQUE DE QUOTA D'INVOCATION CCR D'UN RUN,
  SA CONSOMMATION DURABLE,
  ET L'ATTRIBUTION DE CETTE CONSOMMATION PAR DÉCLENCHEUR
```

Et rien d'autre.

## 1.2 Surface publique visée

```text
ccr run-invocation-accounting <run_id> --format json
```

Un seul document JSON sur la sortie standard, à n'analyser qu'après un code de
sortie `0`.

## 1.3 Ce que ce contrat n'est pas

```text
CE CONTRAT   ≠ observation d'usage fournisseur
             ≠ jetons, coût, devise, estimation
             ≠ quota fournisseur
             ≠ fait d'issue d'invocation
             ≠ activité procédurale
             ≠ état opérationnel natif
             ≠ intention de production
             ≠ disponibilité d'un plan de transfert
```

## 1.4 Relations d'autorité

```text
CE CONTRAT             autorité de la comptabilité d'invocation d'un run

INVOCATION-OUTCOMES    autorité des faits dédiés d'issue d'invocation persistés
RUN-ACTIVITY           autorité de l'activité procédurale
PRODUCTION-INTENT      autorité de l'intention de production
```

```text
INVOCATION ENGAGÉE   ≠  FAIT D'ISSUE D'INVOCATION
INVOCATION ENGAGÉE   ≠  ACTIVITÉ
```

Une invocation engagée peut n'avoir aucun fait d'issue : c'est un état normal, et
non une anomalie. Un tableau d'issues vide ne nie donc aucune invocation
engagée, et ne se soustrait d'aucun compte. Réciproquement, une activité n'est ni
une invocation, ni un compte d'invocations. Les contrats ne se déduisent pas les
uns des autres.

---

# 2. Statut de projection

```text
AVAILABLE            la comptabilité est établie pour ce run
PROJECTION_FAILURE   la comptabilité s'applique mais n'a pas pu être produite
                     de façon fiable
```

Les deux issues sortent en code `0`. `PROJECTION_FAILURE` n'est pas un échec de
commande.

## 2.1 Ce qui produit `PROJECTION_FAILURE`

```text
document de politique PRÉSENT mais illisible
journal d'invocations PRÉSENT mais illisible
```

Une gouvernance en panne ne se présente jamais comme une absence de règle, et une
incapacité à compter ne se présente jamais comme un zéro.

```text
PROJECTION_FAILURE   ≠ absence de politique
                     ≠ consommation nulle
                     ≠ absence de données
                     ≠ défaut du run
```

## 2.2 Ce qui ne produit pas `PROJECTION_FAILURE`

```text
document de politique ABSENT     → AVAILABLE · politique NONE
journal d'invocations ABSENT     → AVAILABLE · couverture PRE_LEDGER
```

L'absence est un fait exact, projeté comme tel.

## 2.3 Sélecteur

Le `<run_id>` fourni **doit désigner un run découvrable**. L'autorité qui en
décide n'est pas créée ici : c'est celle, déjà supportée, de l'inventaire de
runs.

```text
AUTORITÉ DE RÉSOLUTION DU SÉLECTEUR
  =  autorité de découvrabilité de l'inventaire de runs
```

```text
LE SÉLECTEUR RÉSOUT
  SI ET SEULEMENT SI
l'identité de run est reconnue DÉCOUVRABLE
par l'autorité d'énumération des runs de CCR
```

Autorité de l'identité de run découvrable :
[`docs/specs/run-inventory-machine.md`](run-inventory-machine.md).

**Réemploi d'autorité sémantique, non composition procédurale.** Aucun
consommateur n'est tenu d'appeler une surface F1 avant celle-ci. Ce contrat
n'ajoute aucune séquence d'appels, aucune dépendance de commande, et aucune
obligation d'ordre. Les deux surfaces descendent de la **même** autorité ; elles
ne s'appellent pas l'une l'autre.

Cette résolution précède **toute** interprétation de domaine :

```text
RÉSOLUTION DU SÉLECTEUR
  →  AVANT budget_policy
  →  AVANT coverage
  →  AVANT consumed · remaining · exhausted
  →  AVANT trigger_attribution
  →  AVANT projection_status
```

Ce contrat ne nomme aucun fichier, aucun chemin et aucun code d'erreur interne :
la façon dont l'autorité de découvrabilité conclut est un détail
d'implémentation, jamais une API publique.

### 2.3.1 La découvrabilité ne dépend pas de la lisibilité

L'inventaire de runs l'énonce pour lui-même, et ce contrat ne le réinterprète
pas — il en hérite :

```text
« La lisibilité des documents d'un run n'est pas une condition d'inclusion. »
                                          run-inventory-machine.md · § 1.2
```

Il suit, pour ce contrat :

```text
identité découvrable · métadonnée de domaine ABSENTE     →  SÉLECTEUR RÉSOLU
identité découvrable · métadonnée de domaine ILLISIBLE   →  SÉLECTEUR RÉSOLU
identité NON DÉCOUVRABLE                                 →  SÉLECTEUR NON RÉSOLU
```

Par **métadonnée de domaine**, ce contrat entend toute donnée décrivant le run
qui n'est pas une autorité de ce contrat — sa génération d'exécution, son état
opérationnel, son titre. Aucune d'elles n'est un préalable ici, et leur
défaillance ne se convertit en aucun fait de ce contrat.

### 2.3.2 Sélecteur qui ne résout pas

```text
code de sortie          1
stdout                  AUCUN document machine
                        ni abouti, ni partiel
projection_status       AUCUN — il n'existe pas de document de projection
stderr                  un diagnostic est permis · non normatif
```

Une identité non découvrable n'est pas un run dont on rendrait un état comptable :
il n'y a pas d'objet dont parler, et ce contrat ne fabrique rien pour combler ce
vide.

### 2.3.3 Ce que les faits de ce contrat présupposent

```text
budget_policy = NONE     fait autoritatif sur un run DÉCOUVRABLE
                         — aucune politique de quota n'y a été posée
coverage = PRE_LEDGER    fait de couverture sur un run DÉCOUVRABLE
                         — son historique comptable n'est pas reconstructible
projection_status
  = AVAILABLE            fait de projection sur un run DÉCOUVRABLE
```

Aucun des trois ne décrit une identité non découvrable, et aucun ne peut servir à
la représenter.

```text
IDENTITÉ NON DÉCOUVRABLE   ≠  NONE
IDENTITÉ NON DÉCOUVRABLE   ≠  PRE_LEDGER
IDENTITÉ NON DÉCOUVRABLE   ≠  AVAILABLE
```

Employer l'un d'eux pour un sélecteur qui ne résout pas affirmerait une propriété
d'un objet qui n'existe pas — et ferait passer une ignorance pour une
connaissance exacte, ce que le § 4.4 interdit déjà pour toute autre
représentation.

Réciproquement, et c'est l'autre bord :

```text
NONE                 ≠  sélecteur non résolu
PRE_LEDGER           ≠  sélecteur non résolu
PROJECTION_FAILURE   ≠  sélecteur non résolu
```

### 2.3.4 Ce contrat n'a aucun étage d'applicabilité

Le sélecteur résolu, ce contrat n'évalue plus que **ses propres autorités** :

```text
politique d'invocation      § 4
journal d'invocations       § 5 · § 6 · § 7
```

Et rien d'autre. La génération d'exécution du run et sa métadonnée
opérationnelle ne deviennent **pas** un préalable : elles ne sont pas des
autorités de ce contrat (§ 1.4), et la comptabilité d'invocation s'applique à
tout run découvrable, quelle que soit sa génération.

```text
CE CONTRAT   =  résolution du sélecteur, puis projection
             SANS étage d'applicabilité de domaine
```

Conséquences, exhaustives, pour un run découvrable :

```text
politique ABSENTE                            →  budget_policy NONE      · § 2.2
journal ABSENT                               →  coverage PRE_LEDGER     · § 2.2
politique PRÉSENTE mais ILLISIBLE            →  PROJECTION_FAILURE      · § 2.1
journal PRÉSENT mais ILLISIBLE               →  PROJECTION_FAILURE      · § 2.1
métadonnée de domaine ABSENTE ou ILLISIBLE   →  SANS EFFET sur ce contrat
```

`PROJECTION_FAILURE` nomme la défaillance d'une autorité **de ce contrat**, après
résolution du sélecteur, et rien d'autre. Une métadonnée de domaine absente ou
illisible n'en est donc jamais une cause, pas plus qu'elle n'est un échec de
sélecteur.

```text
identité NON DÉCOUVRABLE
  →  code de sortie 1 · aucun document · § 2.3.2

identité DÉCOUVRABLE
  →  CE CONTRAT RÉPOND — que sa métadonnée de domaine soit établie,
     absente ou illisible, et quelle que soit sa génération
     le document rendu ne dépend QUE des faits de politique et de journal
```

---

# 3. Document

## 3.1 Enveloppe

```text
run_invocation_accounting_contract_version               entier · 1
run_invocation_accounting_machine_representation_version entier · 1
run_id                                                   identité du run demandé
projection_status                                        AVAILABLE | PROJECTION_FAILURE
```

Sous `PROJECTION_FAILURE`, aucune autre clé n'est rendue. Aucune valeur de repli
n'est fabriquée.

## 3.2 Sous `AVAILABLE`

```text
budget_policy        union discriminée · § 4
coverage             PRE_LEDGER | SINCE_LEDGER_START · § 6
consumed             entier · PRÉSENT UNIQUEMENT sous SINCE_LEDGER_START · § 5
remaining            entier · PRÉSENT UNIQUEMENT sous CONFIGURED
                                              ET SINCE_LEDGER_START · § 5.3
exhausted            booléen · mêmes conditions que remaining · § 5.4
trigger_attribution  objet dense · PRÉSENT UNIQUEMENT sous
                                              SINCE_LEDGER_START · § 7
```

Une clé absente est **structurellement** absente. Elle n'est jamais rendue à
`null`, ni à `0`, ni à une chaîne sentinelle.

---

# 4. Politique de budget

## 4.1 Union discriminée

```text
budget_policy = { "kind": "NONE" }
              | { "kind": "CONFIGURED", "max_invocations": <entier >= 0> }
```

## 4.2 Sens exact

```text
NONE         aucune politique de quota CCR n'a été posée sur ce run
             aucun refus de quota ne s'applique
CONFIGURED   une politique existe · max_invocations en est la valeur
```

## 4.3 Non-identités

```text
NONE                    ≠ maximum 0
NONE                    ≠ UNKNOWN
NONE                    ≠ budget illimité connu
max_invocations = 0     politique VALIDE
                        aucun engagement d'invocation permis
```

`NONE` et `max_invocations = 0` sont **opposés** : le premier dit qu'aucune règle
n'existe, le second qu'une règle interdit tout.

## 4.4 Représentations interdites

L'absence de politique ne se représente ni par `null`, ni par `-1`, ni par une
valeur infinie, ni par un `UNKNOWN`. Toutes décriraient une ignorance, alors que
CCR sait exactement qu'aucune règle n'a été posée.

## 4.5 Stabilité

La politique se pose à la création du run et n'est plus modifiable. Ce contrat ne
publie donc aucun horodatage de politique, et aucune histoire de politique.

---

# 5. Consommation

## 5.1 Unité comptable

```text
INVOCATION NATIVE CONSOMMÉE
= UN ENGAGEMENT DURABLE CCR
= UNE UNITÉ `DISPATCH_COMMITTED` DU JOURNAL D'INVOCATIONS
```

C'est **la même unité** que celle qu'applique le contrôle de quota. Aucune autre
grandeur ne fait autorité pour ce champ.

```text
NON AUTORITAIRE POUR `consumed`
  nombre d'activités procédurales
  nombre de faits d'issue d'invocation
  nombre d'observations d'usage fournisseur
  curseur d'allocation d'identifiants
```

Un curseur d'allocation dépasse le compte sur un journal aux identifiants non
contigus : il ne peut donc pas servir de compte.

## 5.2 Frontières d'engagement

```text
échec fournisseur POSTÉRIEUR à l'engagement   → l'invocation RESTE consommée
refus de quota AVANT l'engagement             → aucune invocation consommée
échec quelconque AVANT l'engagement           → aucune invocation consommée
absence de fait d'issue d'invocation          → n'efface ni ne nie l'engagement
opération n'appelant aucun fournisseur        → aucune invocation consommée
```

L'unité est consommée par l'ajout autoritaire au journal, et par lui seul.

## 5.3 `remaining`

```text
remaining = max(max_invocations − consumed, 0)
```

Dérivé, jamais persisté. Le persister créerait une seconde vérité, capable de
contredire le journal.

```text
PRÉSENT      budget_policy.kind = CONFIGURED  ET  coverage = SINCE_LEDGER_START
ABSENT       dans tous les autres cas
```

Sous `NONE`, il n'existe pas un restant nul : il n'existe pas de restant.

## 5.4 `exhausted`

```text
exhausted = consumed >= max_invocations
```

Seul dérivé booléen du contrat. Il décrit la **politique**, jamais une capacité
métier.

```text
exhausted = false   ≠ un pas est admissible
exhausted = false   ≠ une invocation aboutira
exhausted = true    ≠ le run est terminé
```

---

# 6. Couverture

```text
PRE_LEDGER           aucun journal d'invocations n'existe pour ce run
                     l'activité d'invocation antérieure n'est pas reconstructible
SINCE_LEDGER_START   le journal existe · le compte est exact depuis sa première ligne
```

## 6.1 Ce que `PRE_LEDGER` interdit

Sous `PRE_LEDGER`, le contrat ne rend **ni** `consumed`, **ni** `remaining`,
**ni** `exhausted`, **ni** `trigger_attribution`.

```text
PRE_LEDGER   ≠ zéro invocation historique
PRE_LEDGER   ≠ run inactif
PRE_LEDGER   ≠ défaut du run
```

Un run antérieur à l'instrumentation peut porter de nombreuses réponses de modèle
et n'avoir aucun journal. Les deux faits sont vrais ; la couverture est ce qui les
réconcilie.

## 6.2 Interdiction du faux zéro

Aucune implémentation conforme ne peut projeter un compte de `0` au motif qu'un
journal est absent. Ne pas savoir compter n'a jamais voulu dire zéro.

---

# 7. Attribution par déclencheur

## 7.1 Ce qu'un déclencheur dit

```text
DÉCLENCHEUR   dit POURQUOI un engagement d'invocation a été fait
              ≠ ce que l'invocation a produit
              ≠ si elle a réussi
              ≠ si un fournisseur a été observé
              ≠ si un fournisseur a facturé
```

## 7.2 Vocabulaire

Le vocabulaire public est **fermé** et propre à la version de ce contrat. En
version 1 :

```text
START
STEP
SEND
RECOVERY_CONTINUE
CONTROVERSY_DETECTION
EVIDENCE_ADDUCTION
RECONCILIATION_PROPOSAL
```

Il n'existe aucun repli `OTHER`, `CUSTOM` ni `UNKNOWN`. Une valeur d'attribution
hors vocabulaire rend la lecture du journal impossible, et produit donc
`PROJECTION_FAILURE` — jamais une catégorie fourre-tout.

Une version ultérieure de ce contrat peut **ajouter** un déclencheur. Elle n'en
retire aucun, et n'en réinterprète aucun.

## 7.3 Représentation **dense**

```text
trigger_attribution = { "<DÉCLENCHEUR>": <entier >= 0>, … }
```

L'objet porte **une entrée par déclencheur du vocabulaire de la version de ce
contrat**, sans exception. Un déclencheur sans engagement porte la valeur `0`.

La densité est normative, et non un détail de sérialisation : elle rend
structurellement impossible de confondre une absence d'entrée avec une ignorance
historique.

```text
sous SINCE_LEDGER_START
  entrée à 0   = ZÉRO EXACT sur la période couverte
  entrée absente = IMPOSSIBLE — non conforme
```

## 7.4 Somme

```text
somme des valeurs de trigger_attribution = consumed
```

Invariant normatif, sous `SINCE_LEDGER_START`.

## 7.5 Attribution de `START`

La part attribuable à `ccr start` est lue directement à l'entrée `START`. Aucun
consommateur n'a à la dériver d'un autre contrat, ni d'une soustraction entre
contrats. Une telle dérivation est explicitement **non supportée**.

---

# 8. Sémantiques négatives

```text
non découvrable   aucun document · code de sortie 1 · voir § 2.3
métadonnée de domaine absente ou illisible
                  sans effet sur ce contrat · voir § 2.3.4
faux              n'apparaît que pour `exhausted`, et décrit la politique
zéro              un compte exact de zéro engagement, sous SINCE_LEDGER_START
absent            politique absente = kind NONE
                  champ absent = structurellement non applicable dans ce cas
inconnu           PRE_LEDGER · jamais converti en zéro
non enregistré    ≠ n'a pas eu lieu
non applicable    exprimé par l'absence structurelle du champ, jamais par une valeur
échec de projection  PROJECTION_FAILURE · ≠ absence de données
```

---

# 9. Compatibilité

```text
AXE DE CONTRAT SÉMANTIQUE      version 1
AXE DE REPRÉSENTATION MACHINE  version 1
```

Ces axes sont propres à ce contrat. Ils ne se déduisent d'aucun autre contrat, et
n'en gouvernent aucun.

Aucun contrat public supporté existant n'est modifié, étendu ni réinterprété par
ce document.

---

# 10. Ce que ce contrat ne promet pas

```text
qu'un engagement futur sera permis
qu'un pas est admissible
qu'un fournisseur répondra
qu'une invocation engagée a produit un résultat exploitable
qu'une consommation nulle signifie un run inactif
qu'une politique absente signifie une capacité infinie
```
