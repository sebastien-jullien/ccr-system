# CCR — Spécification · Effet d'invocation machine d'une opération

```text
STATUT                              contrat RATIFIÉ PAR L'HUMAIN
                                    avant la frontière · état 2-bis
                                    à compter d'elle · contrat courant, état 3
IMPLÉMENTATION                      PRÉSENTE DANS LA LIGNE DE BASE SOURCE
CONFORMITÉ DE CE CONTRAT            ÉTABLIE
VERSION DE PUBLICATION PRÉPARÉE     1.3.0
LIGNE DE BASE SUPPORTÉE             AUCUNE avant la frontière
                                    v1.3.0 à compter d'elle
PORTÉE                              effet d'invocation prospectif machine public · lecture seule
CONTRATS SÉMANTIQUES SUPPORTÉS      1
CONTRATS DE REPRÉSENTATION MACHINE  1
REPRÉSENTATION PAR DÉFAUT           1
REPRÉSENTATION 2                    IMPLÉMENTÉE EN LIGNE DE BASE SOURCE · état 2-bis
                                    CONFORME · NON PUBLIÉE · NON SUPPORTÉE
```

Ce document définit la structure et la portée du document machine que produit
`ccr operation-effects --format json`.

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

Tout ce qui précède porte sur la **représentation machine 1**. La représentation
machine 2, définie ci-dessous, n'a pas le même état, et il serait faux de le
laisser croire.

```text
ÉTAT DE LA REPRÉSENTATION MACHINE 2
  =  CIBLE NORMATIVE RATIFIÉE PAR L'HUMAIN
     IMPLÉMENTÉE EN LIGNE DE BASE SOURCE · CONFORME
     NON PUBLIÉE · NON SUPPORTÉE
     état 2-bis au sens de compatibility.md § 3.4.1

LA SEULE REPRÉSENTATION MACHINE SUPPORTÉE À CE JOUR
  =  la représentation 1

CE QUI EST ÉTABLI     le texte normatif de la représentation 2 · une
                      implémentation conforme dans la ligne de base source · sa
                      conformité, vérifiée pour CE contrat
CE QUI NE L'EST PAS   aucune version publiée ne la rend · elle n'est le contrat
                      public supporté d'aucune version · la conformité établie
                      ne vaut pas vérification complète du dépôt

FRONTIÈRE DE PUBLICATION DE LA REPRÉSENTATION 2
  =  celle de la version de paquet qui la matérialisera, au sens générique de
     compatibility.md § 2.2
     aucune version de paquet n'est désignée ici, et ce contrat n'en dépend pas

LA REPRÉSENTATION 1 NE CHANGE PAS D'ÉTAT
  publiée · supportée · rendue par défaut · inchangée
```

Les deux représentations ne partagent donc pas le même état. Un énoncé de ce
document portant sur « une implémentation conforme » vaut pour la représentation
1 dans la version publiée, et pour la représentation 2 dans la ligne de base
source — sa frontière de publication reste à franchir, et elle seule datera son
entrée dans le contrat public supporté.

---

# 1. Autorité et portée

## 1.1 Ce que ce document possède

```text
CE QU'UNE OPÉRATION SUPPORTÉE PEUT ENGAGER EN INVOCATIONS CCR,
  ET SI ELLE PEUT APPELER UN FOURNISSEUR
```

Et rien d'autre.

## 1.2 Surface publique visée

```text
ccr operation-effects --format json
                      [--machine-representation-version <entier>]
```

Un seul document JSON sur la sortie standard, à n'analyser qu'après un code de
sortie `0`.

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

L'appel historique `ccr operation-effects --format json` continue de signifier la
représentation 1, et rend exactement les six entrées qu'il rendait, aux mêmes
valeurs. Rien de nouveau n'atteint un consommateur qui n'a rien demandé.

Le sélecteur appartient à la représentation 2, dont l'état est celui énoncé en
tête de document : aucune version publiée ne le fournit à ce jour.

Valeur de sélecteur non supportée :

```text
défaut d'usage   →  code de sortie 2
                 →  aucun document JSON sur la sortie standard
```

L'usage se juge **avant** toute lecture, et un document partiel n'est jamais rendu
(§ 2). Le contenu de la sortie d'erreur n'est pas normé par ce contrat.

## 1.3 Portée opération, jamais run

```text
AUCUN run_id N'EST REQUIS
AUCUN run_id N'EST ACCEPTÉ
```

Ce contrat répond **avant** qu'un run existe. C'est sa raison d'être : un
consommateur qui prépare une création de run doit pouvoir connaître l'effet
d'invocation possible de l'opération avant de la déclencher.

Il ne lit aucun run, aucune politique, aucun journal, aucun état.

Cela vaut pour **toute** représentation. Aucune représentation de ce contrat ne
dépend d'un état de run, d'un état de quota, d'une controverse, d'un matériau,
d'une admissibilité courante ni d'une disponibilité au runtime. La représentation
sélectionnée change le vocabulaire rendu, jamais la nature statique de la
réponse.

## 1.4 Ce que ce contrat n'est pas

```text
CE CONTRAT   ≠ comptabilité d'un run
             ≠ consommation réelle
             ≠ admission
             ≠ réservation de budget
             ≠ estimation de coût
             ≠ état opérationnel
             ≠ garantie d'exécution
```

## 1.5 Frontière avec la comptabilité d'un run

```text
CE CONTRAT   autorité de l'effet d'invocation PROSPECTIF INTRINSÈQUE
             d'une opération

RUN-INVOCATION-ACCOUNTING
             autorité de la comptabilité RÉTROSPECTIVE, propre à un run,
             des engagements d'invocation réellement produits
```

Les deux autorités portent sur des objets différents, et ne se contredisent
jamais.

```text
CE CONTRAT publie          EXACT(1) pour STEP
LA COMPTABILITÉ d'un run   0 engagement pour une tentative donnée

  →  les deux énoncés sont VRAIS SIMULTANÉMENT
     lorsque l'exécution n'a jamais atteint le chemin d'engagement
  →  ce n'est PAS une contradiction
```

Aucun consommateur ne doit lire un effet publié comme une prédiction du compte
qu'un run affichera.

## 1.6 Frontière avec l'admission de quota

```text
EFFET D'OPÉRATION   ≠   ADMISSION DE QUOTA
```

Un effet n'affirme pas qu'un budget suffisant existe.

```text
STEP = EXACT(1)
  +  quota refusant avant l'engagement
  →  consommation réelle 0

START = AT_MOST(2)
  →  ne réserve aucune unité
  →  n'affirme pas que deux unités sont disponibles
```

## 1.7 Frontière avec l'admissibilité d'une opération

```text
EFFET D'OPÉRATION   ≠   ADMISSIBILITÉ D'UNE OPÉRATION
```

Ce contrat ne répond pas, et ne doit pas être lu comme répondant, à la question :

```text
puis-je exécuter cette opération maintenant ?
```

Aucune autorité publique ne possède aujourd'hui cette question. Ce document n'en
institue aucune.

## 1.8 Frontière avec le comportement fournisseur

```text
ENGAGEMENT D'INVOCATION NATIVE   ≠   OBSERVATION D'UN APPEL FOURNISSEUR
```

`may_call_provider` et `invocation_effect` sont deux sémantiques distinctes.

```text
may_call_provider = YES
  ≠ un appel fournisseur aura lieu
  ≠ un appel fournisseur réussira
  ≠ une invocation sera nécessairement engagée
```

Sauf énoncé exact d'un autre contrat, rien de tel ne se déduit d'ici.

---

# 2. Statut de projection

Ce contrat est **statique** : il ne dépend d'aucun état persistant, d'aucun run et
d'aucun fichier de données. Il n'a donc pas de statut de projection, et n'emprunte
pas le vocabulaire des contrats de run.

```text
succès   code de sortie 0 · document complet
échec    code de sortie non nul · aucun document
```

Il n'existe ni `AVAILABLE`, ni `UNAVAILABLE`, ni `PROJECTION_FAILURE` dans ce
contrat. Un document partiel n'est jamais rendu.

---

# 3. Document

```text
operation_invocation_effect_contract_version               entier · 1
operation_invocation_effect_machine_representation_version entier · 1 | 2
operations                                                 tableau · § 4
```

`operation_invocation_effect_machine_representation_version` porte la
représentation **effectivement rendue** : `1` lorsque le sélecteur est absent ou
vaut 1, `2` lorsqu'il vaut 2. Il ne dit rien de ce qu'une implémentation saurait
rendre par ailleurs.

Le tableau est **dense** : il porte une entrée par opération du vocabulaire de la
représentation rendue (§ 5), sans exception. L'ordre du tableau ne porte aucune
sémantique.

---

# 4. Entrée d'opération

```text
operation            vocabulaire fermé · § 5
may_call_provider    YES | NO | NOT_AVAILABLE · § 6
invocation_effect    union discriminée · § 7
```

---

# 5. Vocabulaire d'opération

Vocabulaire **fermé et versionné**, propre à chaque représentation machine.

### Représentation 1

Elle admet **exactement** ces six valeurs, et aucune autre :

```text
START
STEP
SEND
PAUSE
RESUME
HANDOFF
```

### Représentation 2

Elle admet **exactement** ces neuf valeurs, et aucune autre :

```text
START
STEP
SEND
PAUSE
RESUME
HANDOFF
DETECT
PROPOSE
ADDUCE_MODEL
```

Les six premières sont celles de la représentation 1, **inchangées** : mêmes
identités, mêmes valeurs (§ 8). La représentation 2 ne remplace pas la
représentation 1 ; elle s'y ajoute.

### Identité d'opération, jamais identité de déclencheur

```text
IDENTITÉ D'OPÉRATION DE CE CONTRAT
  ≠  IDENTITÉ DE DÉCLENCHEUR DE LA COMPTABILITÉ D'INVOCATION
```

`DETECT`, `PROPOSE` et `ADDUCE_MODEL` nomment des **opérations** — ce qu'un
appelant déclenche. Le vocabulaire de déclencheurs de
[`run-invocation-accounting-machine.md`](run-invocation-accounting-machine.md)
nomme, lui, **pourquoi** un engagement a été fait ; ses littéraux propres au
domaine lui appartiennent, et ce contrat ne les emploie pas.

Que `START`, `STEP` et `SEND` s'écrivent de la même façon dans les deux
vocabulaires est un fait, jamais une règle de correspondance. Aucun consommateur
ne doit dériver un vocabulaire de l'autre, dans un sens ni dans l'autre.

## 5.1 Règle d'extension

```text
AJOUT D'UNE OPÉRATION AU DOCUMENT
  →  EXIGE une nouvelle version de représentation machine

RETRAIT OU RÉINTERPRÉTATION D'UNE OPÉRATION
  →  EXIGE une nouvelle version de contrat sémantique
```

Une opération supportée nouvellement introduite dans le produit **n'apparaît
pas** dans un document de représentation 1. Un consommateur conforme de la
représentation 1 reçoit donc toujours les six mêmes entrées, et peut traiter
toute autre valeur comme une non-conformité — jamais comme une extension
silencieuse.

La règle vaut pour **toute** représentation : ce qui n'est pas au vocabulaire de
la représentation rendue n'y apparaît pas.

```text
COUVERTURE D'UNE REPRÉSENTATION
  =  son propre vocabulaire, clos et énuméré

  ≠  toute opération publique de CCR
  ≠  toute opération publique susceptible d'engager une invocation
```

La présente évolution n'institue aucune obligation générale de couvrir toute
opération publique de CCR. L'entrée d'une opération dans ce document se décide
opération par opération, et se matérialise par la règle d'extension ci-dessus.
Ce document ne statue pas sur une politique de couverture ultérieure.

```text
VALEUR D'OPÉRATION HORS VOCABULAIRE
  ≠  UNKNOWN
  =  document non conforme
```

`UNKNOWN` qualifie un **effet**, jamais un nom d'opération.

---

# 6. Appel de fournisseur

```text
YES             l'opération peut appeler un fournisseur
NO              l'opération n'appelle aucun fournisseur
NOT_AVAILABLE   l'opération n'est pas exécutable par cette voie ; ce qu'elle
                consommerait ensuite n'appartient pas à CCR
```

Trois états, et non un booléen. `NOT_AVAILABLE` n'est pas « non » : répondre
« non » laisserait croire que l'opération est inoffensive, répondre « oui »
qu'elle est déclenchable ici. Ni l'un ni l'autre n'est vrai.

```text
may_call_provider = YES   ≠ un nombre exact d'invocations
may_call_provider = YES   ≠ l'opération est admissible
may_call_provider = NO    ≠ l'opération est sans effet
```

---

# 7. Effet d'invocation

## 7.1 Domaine

```text
invocation_effect = { "kind": "EXACT",   "count": <entier >= 0> }
                  | { "kind": "AT_MOST", "count": <entier >= 1> }
                  | { "kind": "UNKNOWN" }
```

## 7.2 Nature : effet INTRINSÈQUE, prospectif

```text
EFFET D'INVOCATION DE CE CONTRAT
= EFFET D'INVOCATION PROSPECTIF INTRINSÈQUE DE L'OPÉRATION REPRÉSENTÉE
```

Il décrit la **cardinalité d'engagement** de la sémantique d'opération
représentée. Il ne décrit pas :

```text
l'admissibilité de l'opération sur un run donné
la disponibilité d'un budget
la réussite d'une exécution
l'observation d'un fournisseur
la consommation historique réelle d'un run
```

## 7.3 Sens exact

```text
EXACT(n)
  Lorsque l'exécution atteint le chemin d'engagement d'invocation gouverné par
  l'effet représenté, ce chemin a une cardinalité d'engagement exacte de n.

AT_MOST(n)
  Sur l'exécution gouvernée par l'effet représenté, il ne peut être produit plus
  de n engagements d'invocation native. Le compte réellement engagé peut valoir
  de 0 à n, selon le chemin d'exécution emprunté.

UNKNOWN
  CCR n'expose aucune cardinalité d'engagement prospective finie faisant
  autorité pour l'effet représenté.
```

## 7.4 Frontière d'applicabilité — normative

Un effet publié **ne garantit jamais** qu'une opération émise produira le compte
publié.

```text
REFUS ANTÉRIEUR À L'ENGAGEMENT
ÉCHEC ANTÉRIEUR À L'ENGAGEMENT
EXÉCUTION N'ATTEIGNANT PAS LE CHEMIN D'ENGAGEMENT

  →  peuvent donner 0 engagement réel
  →  NE CONTREDISENT PAS l'effet publié
```

En particulier :

```text
STEP = EXACT(1)
  +  quota refusant avant l'engagement
  →  0 engagement réel
  →  COHÉRENT, et non contradictoire
```

Aucune formulation de ce contrat ne doit se lire comme :

```text
commande émise  →  n engagements garantis
```

Ce n'est pas ce qu'un effet dit, et ce n'est jamais ce qu'il a dit.

## 7.5 Non-identités

```text
UNKNOWN       ≠ zéro
UNKNOWN       ≠ illimité
UNKNOWN       ≠ erreur
EXACT(0)      l'opération n'engage aucune invocation — fait exact, pas une absence
EXACT(n)      ≠ n unités sont disponibles
AT_MOST(n)    ≠ n unités seront consommées
AT_MOST(n)    ≠ n unités sont réservées
```

## 7.6 Aucune réservation

```text
EFFET PROSPECTIF   ≠   BUDGET RÉSERVÉ
```

Le contrôle de quota est rejoué **avant chaque tentative**, à partir du journal
réel. Une opération qui engage deux unités n'en réserve aucune : la première est
comptée par le journal, et le second contrôle la voit.

---

# 8. Valeurs par représentation

**Représentation 1**

```text
opération   may_call_provider   invocation_effect
STEP        YES                 EXACT(1)
SEND        YES                 EXACT(1)
START       YES                 AT_MOST(2)
PAUSE       NO                  EXACT(0)
RESUME      NO                  EXACT(0)
HANDOFF     NOT_AVAILABLE       UNKNOWN
```

**Représentation 2**

```text
opération      may_call_provider   invocation_effect
STEP           YES                 EXACT(1)
SEND           YES                 EXACT(1)
START          YES                 AT_MOST(2)
PAUSE          NO                  EXACT(0)
RESUME         NO                  EXACT(0)
HANDOFF        NOT_AVAILABLE       UNKNOWN
DETECT         YES                 EXACT(1)
PROPOSE        YES                 EXACT(1)
ADDUCE_MODEL   YES                 EXACT(1)
```

Les six valeurs héritées sont **identiques**, jusqu'au jeton. La représentation 2
n'en réinterprète aucune et n'en modifie aucune cardinalité ; `HANDOFF` y reste
`NOT_AVAILABLE` et `UNKNOWN`.

## 8.1 `START` — sémantique normative

```text
START = AT_MOST(2)
```

Le contrôle de quota s'applique **par créneau d'expert manquant**. Une
initialisation partielle n'engage donc qu'une unité, et une naissance nominale à
deux créneaux en engage deux.

```text
AT_MOST(2)   ≠ la consommation réelle sera 2
AT_MOST(2)   ≠ deux unités sont réservées
AT_MOST(2)   ≠ deux créneaux sont disponibles
AT_MOST(2)   ≠ le quota autorisera l'opération
```

La consommation réelle vaut **0, 1 ou 2** selon le chemin d'exécution :

```text
refus de quota avant le premier engagement      0
refus de quota avant le second engagement       1
échec antérieur à un engagement                 moins que le chemin nominal
un seul créneau manquant à compléter            1
chemin nominal à deux créneaux                  2
```

Annoncer `EXACT(2)` serait faux. Annoncer un chiffre là où CCR n'en connaît aucun
le serait tout autant — d'où `UNKNOWN` pour `HANDOFF`.

## 8.2 `HANDOFF`

`HANDOFF` ouvre une session interactive dans un terminal local. Ce qu'elle
consommera ensuite n'appartient pas à CCR, et aucun chiffre ne serait honnête.

## 8.3 `DETECT`, `PROPOSE`, `ADDUCE_MODEL` — sémantique normative

Ces trois opérations sont **demandées par un humain**, portent chacune un
périmètre nommé, et engagent, lorsque l'exécution atteint leur chemin
d'engagement, **une invocation, et une seule**.

```text
DETECT         EXACT(1)     ccr detect
PROPOSE        EXACT(1)     ccr propose
ADDUCE_MODEL   EXACT(1)     ccr adduce-model
```

Aucune n'a de multiplicité de créneau. C'est ce qui les distingue de `START`,
dont le contrôle de quota s'applique par créneau d'expert manquant (§ 8.1). Un
périmètre plus large ne se traduit jamais par plusieurs engagements : il
dimensionne ce qui est soumis, jamais le nombre d'appels.

Les faits qui fixent ces cardinalités appartiennent aux contrats de domaine, qui
les publient déjà et que ce document **ne modifie ni ne réinterprète** :

```text
DETECT         controversy.md      § 13.3  chaîne d'engagement unique
                                   § 23    branches d'échec énumérées, sans rejeu

PROPOSE        reconciliation.md   § 35.4  instantané unique, contexte unique, et
                                           refus déterministe antérieur à tout
                                           engagement lorsque la borne est
                                           dépassée
                                   § 37    chaîne d'engagement unique, sans rejeu
                                           automatique

ADDUCE_MODEL   evidence.md         § 18    chemin en trois phases, un seul appel
                                   § 19    aucun second appel, aucune reprise
```

Ces renvois **expliquent** la valeur ; ils ne la fondent pas une seconde fois.
L'autorité numérique demeure unique (§ 9).

`EXACT(1)` ne signifie pas ici « une invocation à chaque commande émise ». Un
refus de quota, un refus de fraîcheur, un verrou indisponible, un périmètre hors
borne — tous antérieurs à l'engagement — donnent 0 engagement réel sans
contredire l'effet publié (§ 7.4).

## 8.4 Ce que l'extension ne dit pas de `UNKNOWN`

```text
UNKNOWN   =  INDÉTERMINATION FAISANT AUTORITÉ
          ≠  AUTORITÉ MANQUANTE
```

La représentation 2 est définie parce que trois opérations étaient **absentes**
du document, et pour cette seule raison. Elle ne corrige pas `UNKNOWN`, ne le juge
pas insuffisant et n'en réduit pas la portée. Une entrée `UNKNOWN` répond ; une
entrée absente ne répond pas. Les deux situations ne se confondent jamais.

---

# 9. Exigence de non-dérive — normative

## 9.1 Source unique

```text
LA CARDINALITÉ NUMÉRIQUE PUBLIÉE PAR CE CONTRAT
ET
LA CARDINALITÉ RÉELLE ENGAGÉE PAR L'EXÉCUTION DE L'OPÉRATION

DOIVENT PARTAGER UNE SEULE SOURCE SÉMANTIQUE
```

Une implémentation conforme ne maintient pas de table publique indépendante. La
projection consomme la primitive canonique d'effet d'opération ; elle ne la
recopie pas.

## 9.2 À défaut, une preuve mécanique

Si une implémentation ne peut pas partager littéralement la source, elle **doit**
fournir un invariant mécanique qui échoue dès que la cardinalité d'exécution et la
cardinalité publiée divergent.

```text
EXEMPLE NORMATIF DE DÉFAILLANCE À DÉTECTER

  maximum réel d'engagements de START :  2  →  3
  effet publié restant :                 AT_MOST(2)

  → l'invariant DOIT échouer
```

## 9.3 Portée de l'exigence

L'exigence porte sur **la cardinalité numérique**. Une garde qui ne vérifierait que
la capacité d'appeler un fournisseur ne satisfait pas cette section : elle ne
détecterait pas un passage de 2 à 3.

---

# 10. Sémantiques négatives

```text
faux              n'existe pas dans ce contrat : may_call_provider a trois états
zéro              EXACT(0) est un fait exact, jamais une absence
absent            aucune entrée d'opération n'est absente de la représentation
                  rendue : le tableau est dense
inconnu           UNKNOWN · ne signifie ni zéro, ni illimité, ni erreur
non applicable    exprimé par NOT_AVAILABLE sur may_call_provider
échec             code de sortie non nul, sans document
```

---

# 11. Compatibilité

```text
AXE DE CONTRAT SÉMANTIQUE      version 1 · courante et supportée
AXE DE REPRÉSENTATION MACHINE  version 1 · seule supportée, rendue par défaut
                               version 2 · implémentée et conforme en ligne de
                                           base source, état 2-bis
```

Axes propres à ce contrat. Aucun contrat public supporté existant n'est modifié,
étendu ni réinterprété par ce document.

L'ajout de la représentation 2 est **additif**. La représentation 1 conserve son
vocabulaire, ses valeurs et son statut de représentation rendue par défaut ; un
consommateur conforme de la représentation 1 n'a rien à changer, et ne reçoit
rien de nouveau sans l'avoir demandé.

Le contrat sémantique **reste en version 1** : aucune opération n'est retirée,
aucune n'est renommée, aucune n'est réinterprétée, aucune cardinalité publiée
n'est modifiée.

Un changement de la cardinalité publiée d'une opération existante est un
changement de **sens** de ce contrat, et relève de ses propres axes de version ; il
ne se glisse pas dans une correction.

Aucune version de paquet n'est désignée par ce document. Le genre du changement
de paquet, et le numéro qui le portera, relèvent de
[`compatibility.md`](compatibility.md) ; ce contrat n'en dépend pas et ne les
anticipe pas.

---

# 12. Ce que ce contrat ne promet pas

```text
qu'une opération sera admise
qu'un budget est disponible
qu'un fournisseur répondra
qu'une consommation réelle égalera la borne publiée
qu'un coût, une durée ou un nombre de jetons en découle
```
