# CCR — Spécification · Activité durable machine d'un run

```text
STATUT                              contrat courant
PORTÉE                              activité procédurale machine publique · lecture seule
CONTRATS SÉMANTIQUES SUPPORTÉS      1 · 2
CONTRATS DE REPRÉSENTATION MACHINE  1 · 2
REPRÉSENTATION PAR DÉFAUT           1
```

Ce document définit la structure et la portée du document machine produit par
`ccr run-activity <run_id> --format json`.

---

# 1. Autorité et portée

## 1.1 Ce que ce document possède

```text
L'ACTIVITÉ PROCÉDURALE CCR DURABLE, NORMALISÉE,
  pour les familles d'activité explicitement sélectionnées
```

Et rien d'autre.

## 1.2 Surface publique

```text
ccr run-activity <run_id> --format json
                 [--machine-representation-version <entier>]
                 [--runs-dir <répertoire>]
```

`<run_id>` est **obligatoire**. Cette surface ne résout aucun run implicite et
ne choisit jamais de run à la place de l'appelant.

`--format json` est **obligatoire**. Ce contrat ne définit aucune présentation
humaine de cette commande, et aucune n'est promise.

`--machine-representation-version` est **facultative**, et sélectionne la
représentation machine. C'est une dimension **distincte** de `--format` :

```text
--format                           format de sérialisation
--machine-representation-version   représentation machine
```

```text
sélecteur absent   →  représentation 1
sélecteur = 1      →  représentation 1, à l'identique
sélecteur = 2      →  représentation 2
```

```text
AUCUNE MONTÉE IMPLICITE
```

Un consommateur qui n'a rien demandé reçoit exactement le document qu'il lisait.

Valeur non supportée :

```text
code de sortie 2
aucun document JSON sur stdout
```

Même traitement qu'une valeur de `--format` inconnue : l'usage se juge avant
toute lecture.

## 1.3 Procédural, jamais substantiel

Ce contrat rend **ce qui a été durablement engagé et comment cela s'est
procéduralement résolu**. Il ne rend rien de la matière du travail.

```text
CE CONTRAT   ≠ transcript
             ≠ contenu d'un message ou d'une réponse
             ≠ position, objection, controverse, preuve
             ≠ revue substantielle
             ≠ jugement de qualité
```

---

# 2. Statut de projection

Le document porte toujours un discriminant de premier niveau, à vocabulaire
**fermé** :

```text
AVAILABLE
UNAVAILABLE
PROJECTION_FAILURE
```

## 2.1 Sens exact

```text
AVAILABLE
  = applicabilité établie
  + projection F2 autoritative COMPLÈTE produite

UNAVAILABLE
  = l'histoire F2 autoritative requise ne peut pas être établie

PROJECTION_FAILURE
  = applicabilité établie
  + une représentation valide et complète ne peut pas actuellement être
    produite de façon fiable
```

## 2.2 Ce que ces statuts ne sont pas

```text
UNAVAILABLE          ≠ histoire vide
                     ≠ zéro activité
                     ≠ échec de commande
                     ≠ défaut du run

PROJECTION_FAILURE   ≠ échec de commande
                     ≠ histoire absente
                     ≠ défaut du run
                     ≠ échec d'une invocation
```

## 2.3 Frontière avec l'échec de commande

```text
PROJECTION_FAILURE + document machine valide   →  code de sortie 0

la commande ne peut produire AUCUN statut F2 autoritatif
                                               →  code de sortie non nul
                                               →  aucun document sur stdout
```

Les trois statuts sont des **succès de commande**. Un run dont l'applicabilité
elle-même ne peut pas être établie ne rend aucun document.

## 2.4 Discipline machine de la ligne de commande

```text
code de sortie 0
  → stdout = exactement un document JSON valide
  → aucune prose humaine sur stdout

code de sortie 1 · code de sortie 2
  → aucun document abouti ni partiel sur stdout
  → un diagnostic peut être écrit sur stderr
```

Une fin de ligne finale unique est sans sémantique.

---

# 3. Document

Les deux représentations partagent le même document de base. La représentation 2
n'en retire rien, n'en réaffecte rien, et n'y ajoute qu'un seul champ.

## 3.1 `AVAILABLE`

```json
{
  "durable_run_activity_contract_version": 1,
  "durable_run_activity_machine_representation_version": 1,
  "run_id": "…",
  "projection_status": "AVAILABLE",
  "activities": []
}
```

## 3.2 `UNAVAILABLE` et `PROJECTION_FAILURE`

```json
{
  "durable_run_activity_contract_version": 1,
  "durable_run_activity_machine_representation_version": 1,
  "run_id": "…",
  "projection_status": "UNAVAILABLE"
}
```

```text
activities   CLÉ OMISE
```

L'omission **est** le fait. Rendre `activities` vide sous ces deux statuts
donnerait à lire une histoire absente comme une histoire vide, ce que ce
contrat interdit.

Le producteur du contrat v1 émet exactement ces champs de premier niveau, et
eux seuls :

| Champ | Rôle |
|---|---|
| `durable_run_activity_contract_version` | version du contrat sémantique porté |
| `durable_run_activity_machine_representation_version` | version de structure de ce document |
| `run_id` | l'identité du run projeté, **chaîne opaque** |
| `projection_status` | discriminant fermé de la projection |
| `activities` | collection d'activités — **sous `AVAILABLE` uniquement** |

```text
JEU DE CHAMPS DU PRODUCTEUR v1   FERMÉ
```

## 3.3 Représentation 2

```json
{
  "durable_run_activity_contract_version": 2,
  "durable_run_activity_machine_representation_version": 2,
  "run_id": "…",
  "projection_status": "AVAILABLE",
  "production_intent": "STEPS_INTENDED",
  "activities": []
}
```

Un seul champ s'ajoute au jeu de la représentation 1 : `production_intent`.

| Champ | Rôle |
|---|---|
| `production_intent` | intention de production courante du run — **sous `AVAILABLE` uniquement** |

```text
JEU DE CHAMPS DU PRODUCTEUR v2   FERMÉ
```

### `production_intent`

Vocabulaire **fermé** :

```text
STEPS_INTENDED
NO_STEPS_INTENDED
```

C'est un champ de **niveau run**, jamais une activité :

```text
ACTIVITÉ   ≠   FAIT DE CYCLE DE VIE OU D'INTENTION
```

Le vocabulaire fermé d'`activity_kind` n'est pas élargi pour le porter.

### Dérivation normative

```text
aucun fait d'intention applicable
  →  STEPS_INTENDED

dernier fait d'intention applicable = fin de production
  →  NO_STEPS_INTENDED

dernier fait d'intention applicable = réactivation
  →  STEPS_INTENDED
```

### Hors `AVAILABLE`

```text
projection_status ≠ AVAILABLE   →   production_intent   CLÉ OMISE
```

```text
absence   ≠  STEPS_INTENDED
absence   ≠  NO_STEPS_INTENDED
UNKNOWN   ≠  ZERO
```

Aucune intention n'est dérivée d'une histoire déclarée indisponible ou
incomplète : ce serait affirmer depuis des faits partiels.

### Non-affirmations

```text
NO_STEPS_INTENDED   ≠ correction        ≠ complétude
                    ≠ vainqueur         ≠ accord d'un expert
                    ≠ convergence       ≠ controverse résolue
                    ≠ travail épuisé    ≠ quota épuisé
                    ≠ absence de source transférable
                    ≠ run terminé       ≠ CLOSED

STEPS_INTENDED      ≠ pas actuellement admissible
```

Autorité sémantique du fait :
[`docs/specs/production-intent.md`](production-intent.md).

---

# 4. Familles d'activité

Vocabulaire **fermé** de `activity_kind` en v1 :

```text
RUN_START
NATIVE_STEP
HUMAN_SEND
```

## 4.1 Sens

```text
RUN_START     l'activité logique de création et d'initialisation native du run
NATIVE_STEP   un passage de témoin natif entre les deux experts
HUMAN_SEND    un envoi humain adressé à un expert
```

`RUN_START` est **une** activité logique du run.

```text
RUN_START   ≠ un appel fournisseur
            ≠ un tour d'expert
            ≠ une activité par session créée
```

## 4.2 Familles hors périmètre v1

```text
pause
resume
handoff
reprise (recovery)
entretien interne
événements propres à un fournisseur
```

Leur existence dans un run n'entame pas la complétude d'une projection
`AVAILABLE` : elles ne sont simplement pas des activités F2 v1.

---

# 5. Champs communs

Toute activité porte exactement ces quatre champs :

```text
activity_id
sequence
activity_kind
procedural_disposition
```

---

# 6. `activity_id`

```text
opaque
stable pour une même activité logique, d'une observation aboutie à l'autre
unique au sein d'un run
```

```text
même activité logique                        →  même activity_id
activités logiques différentes d'un run      →  activity_id différents
```

```text
activity_id   ≠ identifiant d'événement interne
              ≠ identifiant d'invocation
              ≠ identifiant de session fournisseur
```

## 6.1 Opacité

La forme d'un `activity_id` n'est **pas** une interface machine. Un consommateur
traite la valeur comme une chaîne opaque, ne l'analyse pas, n'en dérive aucun
ordre, aucune famille et aucune donnée du run.

## 6.2 Stabilité à travers les tentatives

Une tentative, une reprise ou une résolution appartenant à la **même** activité
logique conserve le même `activity_id`. Une activité logique ne se dédouble pas
parce qu'elle a été réengagée.

## 6.3 Unicité

Deux activités logiques distinctes d'un même run ne peuvent pas partager un
`activity_id`. Un document `AVAILABLE` portant deux `activity_id` identiques est
une sortie de producteur invalide ; le cas se rend `PROJECTION_FAILURE`.

---

# 7. `sequence`

```text
entier positif
unique au sein d'un run
stable pour une même activité, d'une observation aboutie à l'autre
AUTORITÉ D'ORDRE DURABLE
```

```text
sequence plus petite   →  durablement engagée plus tôt
```

## 7.1 Trous

```text
TROUS   AUCUNE SÉMANTIQUE
```

Les valeurs ne sont ni consécutives, ni un décalage, ni un compte, ni un index.
Un consommateur ne dérive rien d'un écart entre deux valeurs.

## 7.2 Sérialisation et position

Le tableau `activities` est **canoniquement sérialisé par `sequence`
croissante**.

```text
POSITION DANS LE TABLEAU   AUCUNE AUTORITÉ D'ORDRE PROPRE
```

L'ordre fait autorité par la valeur de `sequence`, jamais par l'index. Un
consommateur qui ordonne le fait sur `sequence`.

---

# 8. `procedural_disposition`

Vocabulaire **fermé** :

```text
IN_PROGRESS
COMPLETED
NOT_COMPLETED
UNCERTAIN
```

## 8.1 Sens exact

```text
IN_PROGRESS      activité durablement engagée, canoniquement non résolue

COMPLETED        frontière de complétion procédurale normale,
                 canoniquement établie

NOT_COMPLETED    résolution procédurale terminale sans complétion normale,
                 canoniquement établie

UNCERTAIN        activité durablement engagée, CCR ne peut pas établir
                 canoniquement si la complétion normale a eu lieu
```

## 8.2 Non-affirmations

```text
COMPLETED   ≠ succès substantiel
            ≠ justesse d'un expert
            ≠ acceptation humaine
            ≠ succès d'issue d'invocation

NOT_COMPLETED   ≠ fait dédié d'échec d'invocation
                ≠ motif d'échec
                ≠ diagnostic

UNCERTAIN   ≠ NOT_COMPLETED
            ≠ IN_PROGRESS
```

Les quatre valeurs ne fusionnent jamais. Aucun motif détaillé d'échec n'entre
dans ce contrat.

---

# 9. Variantes

Chaque genre porte **exactement** son jeu de champs. Un champ non applicable est
**structurellement absent**, jamais rendu nul.

```text
ABSENCE   =  CLÉ OMISE
null      =  JAMAIS ÉMIS
```

## 9.1 `RUN_START`

```text
activity_id
sequence
activity_kind = RUN_START
procedural_disposition
```

Champs communs seuls. Ni rôle, ni round.

## 9.2 `NATIVE_STEP`

```text
activity_id
sequence
activity_kind = NATIVE_STEP
procedural_disposition
source_role
target_role
round
```

## 9.3 `HUMAN_SEND`

```text
activity_id
sequence
activity_kind = HUMAN_SEND
procedural_disposition
target_role
```

Ni source, ni round.

---

# 10. Rôles

Vocabulaire **fermé** :

```text
author
challenger
```

```text
RÔLE   ≠  FOURNISSEUR
```

Un rôle est une identité métier du run. Il ne se déduit jamais d'un moteur, et
aucun moteur n'apparaît dans ce document. Deux experts peuvent partager un même
moteur sans cesser d'être deux rôles distincts.

## 10.1 Invariants

```text
NATIVE_STEP   source_role ≠ target_role

HUMAN_SEND    ≠ NATIVE_STEP
HUMAN_SEND    ne consomme aucun round
HUMAN_SEND    ne porte ni source_role ni round
```

Un envoi humain n'entre pas dans la numérotation des rounds et ne déplace pas
l'alternance des passages de témoin.

---

# 11. Applicabilité et complétude

```text
AVAILABLE
  →  représentation autoritative COMPLÈTE
     de RUN_START / NATIVE_STEP / HUMAN_SEND
     pour l'histoire applicable

histoire autoritative insuffisante
  →  UNAVAILABLE

RECONSTRUCTION PARTIELLE
  =  INTERDITE
```

Un fait requis qui ne peut pas être établi — un rôle, un rattachement, un ordre
— n'est jamais deviné, jamais complété par défaut, jamais dérivé d'un
fournisseur. Il rend la projection `UNAVAILABLE`.

## 11.1 Histoire absente

```text
HISTOIRE ABSENTE   ≠   AVAILABLE + activities: []
```

`RUN_START` est une activité F2 **sélectionnée**. Un run dont la base
autoritative de création ne peut pas être établie n'a pas « zéro activité » : il
a une histoire absente, et se rend `UNAVAILABLE`.

## 11.2 `activities: []`

```text
AVAILABLE + activities: []
  =  zéro activité F2 sélectionnée
     au sein d'une histoire applicable entièrement autoritative
```

C'est une **cardinalité**, et une représentation valide de ce contrat.

```text
activities: []   ≠  histoire absente
                 ≠  histoire incomplète
                 ≠  échec de projection
                 ≠  run sans activité passée
```

Cette forme n'est pas un moyen de représenter une histoire manquante, et ne doit
jamais être lue comme tel.

---

# 12. Relations d'autorité

```text
CE CONTRAT             autorité d'activité procédurale

INVOCATION-OUTCOMES    autorité des faits dédiés d'issue d'invocation persistés
```

```text
ACTIVITÉ   ≠  ISSUE D'INVOCATION
```

Une activité n'est ni une invocation, ni un compte d'invocations, ni un
verdict sur une invocation. Les deux contrats ne se joignent pas, ne se
recoupent pas, et aucun ne se déduit de l'autre.

```text
ÉVÉNEMENT INTERNE   ≠  ACTIVITÉ F2 PUBLIQUE
```

Une activité publique est une **normalisation** de faits durables. Ce contrat ne
publie aucun nom d'événement interne, aucun identifiant interne, et aucune règle
de correspondance entre les deux : la façon dont les faits internes sont
normalisés est un détail d'implémentation, jamais une API publique.

Autorité de l'issue d'invocation :
[`docs/specs/invocation-outcome.md`](invocation-outcome.md) et
[`docs/specs/invocation-outcome-machine.md`](invocation-outcome-machine.md).

---

# 13. Exclusions explicites

N'apparaissent jamais dans ce document :

```text
invocation_id
provider · moteur
session · identifiant natif
tout horodatage
corps de message · réponse d'expert · prompt
diagnostic · arguments
corps de preuve · transcript
workspace · chemin · diff
coût · usage
identifiant d'événement interne
motif d'échec détaillé
prose humaine de présentation
```

Aucune persistance n'est exposée comme API.

---

# 14. Contexte

La projection porte sur le **contexte résolu de l'invocation**. `--runs-dir` est
l'entrée de contexte existante ; le chemin physique n'est pas représenté.

---

# 15. Versions

```text
REPRÉSENTATION 1
durable_run_activity_contract_version                 1
durable_run_activity_machine_representation_version   1

REPRÉSENTATION 2
durable_run_activity_contract_version                 2
durable_run_activity_machine_representation_version   2
```

Deux axes distincts et indépendants. Qu'ils portent ici la même valeur est une
coïncidence de cette évolution, jamais une règle : rien ne garantit qu'ils
avanceront toujours ensemble.

```text
VERSION DE CONTRAT   ≠   VERSION DE REPRÉSENTATION
NI L'UN NI L'AUTRE   ≠   VERSION DU PAQUET CCR
```

Une nouvelle version de contrat n'emporte aucune version majeure de paquet, et
ce document n'en décide aucune.

Ces deux axes ne sont pas des discriminants de
protocole, et n'apparaissent pas dans le document :

```text
version du paquet CCR
version de schéma du manifest
version de schéma du state
génération d'exécution
version d'un autre contrat
```

## 15.1 Ce que les versions gouvernent

`durable_run_activity_machine_representation_version` gouverne la structure :
champs admis, jeux de champs par variante, imbrication, omission d'`activities`,
et frontière succès / échec de ce document.

`durable_run_activity_contract_version` gouverne le sens : les trois statuts de
projection, les familles d'activité, la sémantique d'`activity_id` et de
`sequence`, le vocabulaire des dispositions procédurales, les rôles, les
invariants, et le contrat de complétude.

Exigent une évolution explicite de l'axe concerné :

```text
réaffectation du rôle d'un champ
retrait d'un champ requis
ajout ou retrait d'un jeton dans un vocabulaire fermé
renommage rompant le contrat
changement du contrat de complétude ou d'applicabilité
changement de la sémantique d'ordre, d'identité ou de zéro
changement de la frontière succès / échec
```

## 15.2 Ce qui n'est pas décidé

```text
JEU DE CHAMPS DU PRODUCTEUR COURANT
  ≠  POLITIQUE DE CONSOMMATION D'UN CHAMP INCONNU FUTUR
```

Ne sont **pas** définis par le contrat v1 : champs optionnels futurs, champs
supplémentaires inconnus, compatibilité ascendante, politique de compatibilité
additive, ni l'ajout futur d'une famille d'activité.

La même réserve vaut pour le contrat v2. En particulier, l'existence de la
représentation 2 ne crée aucune politique additive : elle est **choisie**, jamais
servie par défaut.

---

# 16. Références d'autorité

| Sujet | Autorité |
|---|---|
| Intention de production d'un run | [`docs/specs/production-intent.md`](production-intent.md) |
| Identité de run découvrable | [`docs/specs/run-inventory-machine.md`](run-inventory-machine.md) |
| Descripteur sémantique de run | [`docs/specs/run-descriptors-machine.md`](run-descriptors-machine.md) |
| Faits d'issue d'invocation | [`docs/specs/invocation-outcome.md`](invocation-outcome.md) |
| Représentation machine des issues | [`docs/specs/invocation-outcome-machine.md`](invocation-outcome-machine.md) |
| Compatibilité des versions du paquet | [`docs/specs/compatibility.md`](compatibility.md) |
| Invariants transverses | [`docs/doctrine.md`](../doctrine.md) |

---

**Une activité n'est pas un jugement.** Ce document dit ce que CCR a
durablement engagé et comment cela s'est procéduralement résolu ; il ne dit rien
de ce qui a été soutenu, contesté ou décidé.
