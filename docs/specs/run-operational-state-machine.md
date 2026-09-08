# CCR — Spécification · État opérationnel machine d'un run natif

```text
STATUT                              cible normative RATIFIÉE PAR L'HUMAIN
IMPLÉMENTATION                      NON IMPLÉMENTÉE
PUBLICATION                         NON PUBLIÉE
LIGNE DE BASE SUPPORTÉE             AUCUNE À CE JOUR
PORTÉE                              état opérationnel natif machine public · lecture seule
CONTRATS SÉMANTIQUES SUPPORTÉS      1
CONTRATS DE REPRÉSENTATION MACHINE  1
REPRÉSENTATION PAR DÉFAUT           1
```

Ce document définit la structure et la portée du document machine que devra
produire `ccr run-operational-state <run_id> --format json`.

```text
AUTORITÉ NORMATIVE   ratifiée par l'humain
IMPLÉMENTATION       aucune · la commande ci-dessus n'est pas fournie
                     par la version courante du produit
SYNTAXE              cible normative ratifiée, non une surface existante
```

Ce document énonce ce qu'une implémentation conforme devra rendre. Il ne
constate pas un comportement existant, et n'ajoute aucun contrat à la ligne de
base supportée d'une version publiée.

---

# 1. Autorité et portée

## 1.1 Ce que ce document possède

```text
L'ÉTAT OPÉRATIONNEL COURANT D'UN RUN NATIF,
  LA PROPRIÉTÉ COURANTE DU CONTRÔLE,
  ET LA DISPONIBILITÉ COURANTE D'UN PLAN DE TRANSFERT
```

Et rien d'autre.

## 1.2 Surface publique visée

```text
ccr run-operational-state <run_id> --format json
```

Un seul document JSON sur la sortie standard, à n'analyser qu'après un code de
sortie `0`.

## 1.3 Courant, jamais historique

Ce contrat rend un **état à l'instant de la lecture**. Il ne publie aucune
histoire, aucun horodatage de transition, aucun journal.

```text
CE CONTRAT   ≠ histoire d'un run
             ≠ comptabilité d'invocation
             ≠ effet prospectif d'une opération
             ≠ intention de production
             ≠ statut de projection d'activité
             ≠ disposition procédurale d'une activité
             ≠ correction du logiciel produit
```

## 1.4 Relations d'autorité

```text
CE CONTRAT             autorité de l'état opérationnel natif courant

RUN-INVOCATION-ACCOUNTING   autorité de la comptabilité d'invocation
OPERATION-INVOCATION-EFFECT autorité de l'effet prospectif d'une opération
PRODUCTION-INTENT           autorité de l'intention de production
RUN-ACTIVITY                autorité de l'activité procédurale
```

Ces autorités sont **indépendantes**. Aucune ne se déduit d'une autre, et ce
contrat n'en agrège aucune.

---

# 2. Statut de projection

```text
AVAILABLE            le run est natif · son état opérationnel est établi
NOT_APPLICABLE       le run existe mais n'est pas de génération native
PROJECTION_FAILURE   l'état s'applique mais n'a pas pu être établi de façon fiable
```

Les trois issues sortent en code `0`.

## 2.1 Non-identités de statut

```text
NOT_APPLICABLE   ≠ UNKNOWN
NOT_APPLICABLE   ≠ PROJECTION_FAILURE
NOT_APPLICABLE   ≠ run inexistant
NOT_APPLICABLE   ≠ run vide
PROJECTION_FAILURE ≠ absence de données
PROJECTION_FAILURE ≠ défaut du run
```

`NOT_APPLICABLE` est une réponse **complète** : le run est connu, et la question
posée n'a pas de sens pour lui. Aucun état natif n'est fabriqué pour un run qui
n'en a pas.

## 2.2 Contenu par statut

```text
AVAILABLE            native_state · terminal · control_owner · next_transfer_plan
NOT_APPLICABLE       aucune autre clé
PROJECTION_FAILURE   aucune autre clé
```

## 2.3 Sélecteur

Le `<run_id>` fourni **doit désigner un run existant** au sens de l'autorité
canonique d'identité de run de CCR. Cette résolution précède **toute**
interprétation de domaine :

```text
RÉSOLUTION DU SÉLECTEUR
  →  AVANT l'applicabilité native
  →  AVANT native_state
  →  AVANT terminal
  →  AVANT control_owner
  →  AVANT next_transfer_plan
  →  AVANT projection_status
```

Ce contrat ne nomme aucun fichier, aucun chemin et aucun code d'erreur interne :
la façon dont CCR établit l'existence d'un run est un détail d'implémentation,
jamais une API publique.

### 2.3.1 Sélecteur qui ne résout pas

```text
code de sortie          1
stdout                  AUCUN document machine
                        ni abouti, ni partiel
projection_status       AUCUN — il n'existe pas de document de projection
stderr                  un diagnostic est permis · non normatif
```

### 2.3.2 Ce que les deux statuts non disponibles présupposent

```text
NOT_APPLICABLE
  = un run CONNU, dont la génération ne porte pas d'état opérationnel natif
  la question a un sujet ; elle n'a pas de sens pour lui

PROJECTION_FAILURE
  = l'applicabilité est ÉTABLIE, et la projection n'a pas pu l'être de façon
    fiable
  la question a un sujet, et la réponse a échoué
```

Un sélecteur qui ne résout pas ne satisfait ni l'une ni l'autre présupposition :
il n'y a pas de sujet.

```text
RUN INEXISTANT   ≠  NOT_APPLICABLE
RUN INEXISTANT   ≠  PROJECTION_FAILURE
```

Aucun statut de projection n'est créé pour le représenter, et le vocabulaire de
`projection_status` n'est pas élargi pour le porter — pas davantage qu'il
n'accueille `UNAVAILABLE`.

---

# 3. Document

```text
run_operational_state_contract_version               entier · 1
run_operational_state_machine_representation_version entier · 1
run_id                                               identité du run demandé
projection_status                                    AVAILABLE | NOT_APPLICABLE
                                                     | PROJECTION_FAILURE
native_state                                         § 4 · sous AVAILABLE
terminal                                             booléen · sous AVAILABLE · § 5
control_owner                                        § 6 · sous AVAILABLE
next_transfer_plan                                   § 7 · sous AVAILABLE
```

---

# 4. État natif

## 4.1 Vocabulaire public

Vocabulaire **fermé**, propre à ce contrat, en version 1 :

```text
READY
RUNNING
WAITING_AGENT
WAITING_HUMAN
PAUSED
RECOVERY_REQUIRED
FAILED_INITIALIZATION
FAILED
CLOSED
```

Ce vocabulaire est **public, fermé et versionné pour lui-même**. Il n'emprunte
son autorité à aucun identifiant interne, et une évolution interne qui n'en change
pas le sens ne change pas ce contrat.

```text
AJOUT OU RETRAIT D'UN ÉTAT
  →  EXIGE une évolution explicite de l'axe sémantique de ce contrat
```

Une valeur hors vocabulaire rend le document non conforme. Il n'existe aucune
valeur de repli, et aucun état n'apparaît silencieusement en version 1.

## 4.2 Sens public de chaque état

```text
READY
  Le run existe et est prêt à recevoir une opération. Aucune opération n'est
  en cours pour son compte.
  NE DIT PAS  qu'une opération sera admise · qu'un quota le permet ·
              qu'un plan de transfert existe

RUNNING
  Une opération de CCR est en cours pour ce run.
  NE DIT PAS  qu'un fournisseur répond · qu'un processus enfant vit ·
              qu'une invocation aboutira

WAITING_AGENT
  CCR a engagé une opération et en attend l'issue.
  NE DIT PAS  que l'issue sera positive · qu'une invocation a été observée ·
              que l'attente a une échéance

WAITING_HUMAN
  Le run attend un geste humain avant toute progression automatique.
  NE DIT PAS  quel geste · qu'un geste est disponible · qu'il est urgent

PAUSED
  L'automatisation a été suspendue. Le run reste intact.
  NE DIT PAS  que le travail est fini · qu'il est abandonné ·
              qu'une reprise est requise

RECOVERY_REQUIRED
  Une opération antérieure a laissé un état dont CCR refuse de décider seul.
  NE DIT PAS  qu'une donnée est perdue · qu'un geste précis est imposé ·
              qu'un rejeu aura lieu

FAILED_INITIALIZATION
  La naissance du run n'a pas abouti complètement.
  NE DIT PAS  qu'aucune invocation n'a été engagée ·
              que le run est irrécupérable · que le run est terminal

FAILED
  Le run porte un échec durable.
  NE DIT PAS  que le run est terminal · qu'aucune reprise n'est possible ·
              que le logiciel produit est incorrect

CLOSED
  Le run est clos. Aucune progression automatique ne s'y produit plus.
  NE DIT PAS  que le travail a convergé · qu'un accord existe ·
              qu'un vainqueur est désigné · que la production était complète
```

## 4.3 Non-identités transverses

```text
ÉTAT NATIF   ≠ propriété du contrôle
ÉTAT NATIF   ≠ intention de production
ÉTAT NATIF   ≠ statut de projection d'activité
ÉTAT NATIF   ≠ disposition procédurale d'une activité
ÉTAT NATIF   ≠ présence ou absence d'un processus
```

---

# 5. Terminalité

```text
terminal = true    UNIQUEMENT pour CLOSED
terminal = false   pour les huit autres états
```

`terminal` est **dérivé et publié explicitement** afin qu'aucun consommateur n'ait
à connaître la liste des états terminaux pour répondre à la question.

```text
terminal = false   ≠ le travail continue
terminal = false   ≠ une opération est admissible
terminal = true    ≠ le travail a réussi
```

---

# 6. Propriété du contrôle

## 6.1 Vocabulaire

Vocabulaire **fermé et versionné**, défini par ce contrat. La version 1 admet
exactement deux valeurs, et aucune autre :

```text
control_owner = AUTOMATION | HUMAN
```

```text
AJOUT OU RETRAIT D'UNE VALEUR
  →  EXIGE une évolution explicite de l'axe sémantique de ce contrat
```

Ce vocabulaire n'emprunte son autorité à aucun identifiant interne. Une valeur
hors vocabulaire rend le document non conforme ; elle ne se replie sur aucune
sentinelle.

## 6.2 Sens public

Dimension **distincte** de l'état, et jamais dérivée de lui.

```text
AUTOMATION   le droit d'émettre automatiquement un nouveau tour appartient à CCR
HUMAN        ce droit appartient à l'opérateur humain
```

```text
AUTOMATION   ≠ un agent s'exécute en ce moment
AUTOMATION   ≠ une opération est admissible
HUMAN        ≠ un humain interagit en ce moment
HUMAN        ≠ le run est suspendu
```

---

# 7. Plan de transfert suivant

## 7.1 Question exacte

```text
CCR dérive-t-il actuellement une source transférable et un plan de transfert,
et si oui, quelles parties non sensibles le définissent ?
```

## 7.2 Forme

```text
next_transfer_plan = { "available": false }
                   | { "available": true,
                       "source_role":  author | challenger,
                       "target_role":  author | challenger,
                       "next_round":   <entier >= 1> }
```

Invariant : `source_role` ≠ `target_role`.

### Autorité du vocabulaire de rôle

Le vocabulaire de rôle n'est **pas défini par ce contrat**. Il est celui, déjà
public, fermé et versionné, de :

```text
docs/specs/run-activity-machine.md · § 10 · Rôles

  author
  challenger

  RÔLE   ≠  FOURNISSEUR
```

Ce contrat s'y **réfère**, et ne le redéfinit pas. Une évolution du vocabulaire de
rôle appartient aux axes de version de ce contrat-là, jamais à ceux-ci : y ajouter
ou en retirer un jeton exige une évolution explicite de son axe sémantique.

```text
RÉFÉRENCE À UN VOCABULAIRE PUBLIC EXISTANT
  ≠  extension de ce vocabulaire
  ≠  modification du contrat qui le possède
  ≠  second vocabulaire concurrent
```

Un rôle est une identité métier du run. Il ne se déduit d'aucun moteur, et aucun
moteur n'apparaît dans ce document.

## 7.3 Nature

Projection **courante et dérivée**. Ce n'est pas un fait durable.

```text
CE N'EST PAS   un événement TRANSFER_PENDING
               une obligation enregistrée
               une réservation
               une trace historique
```

Aucun événement de journal n'est créé, ni requis, pour porter cette information.

## 7.4 Champs publiés, et pourquoi

```text
source_role   identifie l'expert dont la réponse serait transférée.
              Nécessaire : sans lui, la disponibilité ne désigne rien.
target_role   identifie l'expert qui la recevrait.
              Nécessaire : la direction est le fait, et elle ne se déduit ni du
              dernier événement, ni de la parité du round, ni d'un fournisseur.
next_round    situe le transfert dans la séquence du run.
              Nécessaire : sans lui, deux lectures successives sont
              indiscernables.
```

## 7.5 Champs délibérément non publiés

```text
enveloppe composée              détail d'exécution · aucun besoin consommateur
contenu de la source            interdit : contenu substantiel
identifiant d'événement source  identifiant interne · aucune surface publique
                                ne permet de le résoudre
identité de session             interdit
identité de fournisseur         interdit
taille et limite de charge      détail d'exécution
raison d'indisponibilité        § 7.6
```

## 7.6 Aucune raison d'indisponibilité en version 1

```text
RAISON PUBLIQUE D'INDISPONIBILITÉ
= NON EXPOSÉE
```

Le calcul interne d'indisponibilité replie plusieurs autorités distinctes, dont
l'intention de production. Les publier ici créerait une **seconde projection**
d'une autorité qui possède déjà la sienne, et figerait un vocabulaire interne.

Un consommateur qui veut savoir pourquoi aucun plan n'est disponible consulte les
autorités concernées à leur propre surface.

Un besoin démontré pourra rouvrir cette question dans une version ultérieure de ce
contrat ; il ne la rouvre pas ici.

## 7.7 Non-identités — normatives

```text
PLAN DE TRANSFERT DISPONIBLE   ≠ PAS ADMISSIBLE
PLAN DE TRANSFERT DISPONIBLE   ≠ QUOTA DISPONIBLE
PLAN DE TRANSFERT DISPONIBLE   ≠ INTENTION DE PRODUCTION
PLAN DE TRANSFERT DISPONIBLE   ≠ TRAVAIL LOGICIEL RESTANT
PLAN DE TRANSFERT DISPONIBLE   ≠ INVOCATION GARANTIE
PLAN DE TRANSFERT DISPONIBLE   ≠ INVOCATION ENGAGEABLE MAINTENANT
```

Ces énoncés sont **contractuels**, et non des commentaires. En particulier, la
dérivation du plan n'interroge pas la politique de quota : un plan disponible est
parfaitement compatible avec un budget épuisé.

```text
available = false   ≠ le run est terminé
available = false   ≠ le travail est fini
available = false   ≠ une erreur s'est produite
```

---

# 8. Aucune formule d'admissibilité

```text
CES CONTRATS EXPOSENT DES FAITS INDÉPENDAMMENT AUTORITAIRES
```

La comptabilité d'invocation d'un run, l'état opérationnel natif, l'effet
d'invocation prospectif d'une opération et l'intention de production sont quatre
autorités distinctes. Chacune répond de sa seule question.

La composition de ces faits relève de la **politique du consommateur**.

CCR n'affirme pas que leur conjonction constitue un test complet d'admissibilité
d'un pas natif, et ce contrat n'énonce aucune règle de composition.

---

# 9. Sémantiques négatives

```text
run inexistant    aucun document · code de sortie 1 · voir § 2.3
faux              `terminal` et `available` portent un faux exact, jamais une ignorance
zéro              aucun champ numérique de ce contrat n'admet zéro comme sentinelle
absent            champ absent = structurellement non applicable au statut rendu
inconnu           n'existe pas dans ce contrat : l'état courant est connu ou la
                  projection échoue
non applicable    NOT_APPLICABLE · run de génération non native
échec de projection  PROJECTION_FAILURE · ≠ absence de données
```

---

# 10. Compatibilité

```text
AXE DE CONTRAT SÉMANTIQUE      version 1
AXE DE REPRÉSENTATION MACHINE  version 1
```

Axes propres à ce contrat. Aucun contrat public supporté existant n'est modifié,
étendu ni réinterprété par ce document.

La sortie humaine de `ccr status` n'acquiert aucune promesse de compatibilité du
fait de l'existence de ce contrat.
