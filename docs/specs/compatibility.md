# CCR — Spécification · Compatibilité des versions du paquet

```text
STATUT   contrat courant
PORTÉE   compatibilité des versions publiques du paquet CCR,
         à partir de v1.0.0
```

Ce document définit ce qu'une version publique du paquet CCR promet, et ce
qu'elle ne promet pas.

---

# 1. Autorité et portée

Ce document possède la politique de compatibilité **au niveau du paquet**. Il ne
possède aucune sémantique métier : le sens des jetons, des représentations et
des domaines appartient aux contrats qui les portent.

```text
CE DOCUMENT   ce qu'une version de paquet signale
CONTRATS      ce que les surfaces publiques signifient
```

## 1.1 À partir de quand

```text
EFFECTIF À PARTIR DE   CCR v1.0.0
```

À partir de v1.0.0, les versions publiques du paquet CCR constituent un
**signal de compatibilité** portant sur les contrats publics supportés, et CCR
suit le versionnement sémantique pour ces contrats.

Cette politique s'applique à compter de CCR v1.0.0.

---

# 2. Contrat public supporté

Un **contrat public supporté** est un comportement, une représentation, un
domaine sémantique ou un invariant transverse **dont le statut normatif est
explicitement établi par la documentation publique de CCR**.

## 2.1 Ce qui n'est pas automatiquement normatif

```text
README · AIDE CLI        orientation et découverte,
                         sauf déclaration normative explicite

EXEMPLES                 illustration,
                         sauf déclaration normative explicite

CODE · TESTS             preuve d'implémentation,
                         jamais contrat public par défaut

PERSISTANCE INTERNE      pas un contrat public par défaut

DÉTAIL D'IMPLÉMENTATION  n'est pas promu en API publique par v1.0.0

COMPORTEMENT NON DOCUMENTÉ   pas un contrat public supporté par défaut
```

Rien ne devient contrat public supporté par le seul fait d'exister, d'être
observable, ou d'avoir toujours fonctionné ainsi.

---

# 3. Ligne de base supportée de v1.0.0

La ligne de base est **explicitement énumérée**. Aucun document, aucune surface
et aucun artefact du dépôt n'y entre parce qu'il existe.

Documents normatifs désignés pour la ligne de base de v1.0.0 :

**Contrat de niveau paquet**

```text
docs/specs/compatibility.md
```

**Transverse**

```text
docs/doctrine.md
```

**Contrats de domaine**

```text
docs/specs/controversy.md
docs/specs/evidence.md
docs/specs/reconciliation.md
```

**Contrats de projection**

```text
docs/specs/invocation-outcome.md
docs/specs/invocation-outcome-machine.md
docs/specs/run-inventory-machine.md
```

```text
LIGNE DE BASE DE v1.0.0   exactement 8 documents
```

Cette énumération est **close**. Elle devient la ligne de base supportée de
v1.0.0 **lorsque v1.0.0 est publiée**.

## 3.1 Ce que « exactement 8 » veut dire

Ce compte décrit la ligne de base de v1.0.0, **historiquement fixée** à cette
version.

```text
CE QUE CELA DIT       ce que la ligne de base de v1.0.0 contenait
CE QUE CELA NE DIT PAS   que la série 1.x ne pourra jamais supporter
                         de contrat public supplémentaire
```

Une évolution compatible de la 1.x **peut** ajouter un contrat public supporté,
sous la discipline de mineure déjà énoncée au § 6. Ajouter un contrat supporté
plus tard **ne modifie pas rétroactivement** ce que la ligne de base de v1.0.0
contenait.

## 3.2 Le présent document se protège lui-même

Le présent document est un **contrat public supporté**, et il appartient à la
ligne de base qu'il définit. Les règles publiques qui gouvernent la
compatibilité de la ligne de base protégée doivent elles-mêmes appartenir à
cette ligne de base — sans quoi la promesse pourrait être retirée sans jamais
rompre aucune des règles qu'elle énonce.

```text
CHANGEMENT INCOMPATIBLE DE CE DOCUMENT
  qui modifie la promesse de compatibilité supportée au niveau du paquet
    =  rupture d'un contrat public supporté
    →  exige une évolution majeure du paquet
```

Une clarification ou une évolution **compatible** de ce document reste classée
selon les mêmes règles de majeure, mineure et correctif énoncées ci-dessous ;
son appartenance à la ligne de base ne lui confère aucun régime particulier.

## 3.3 Aucune normativité récursive

L'appartenance de ce document à la ligne de base protège **ce document**, et
rien d'autre.

Elle n'implique en particulier pas :

```text
que tout document qu'il référence devienne normatif
que tout artefact du dépôt entre dans la ligne de base
que le README devienne normatif
que l'aide CLI devienne normative
que les exemples deviennent normatifs
que le code ou les tests deviennent normatifs
que la persistance interne devienne une API publique
que les détails d'implémentation deviennent une API publique
```

```text
APPARTENANCE À LA LIGNE DE BASE
  =  les seuls documents explicitement énumérés
```

## 3.4 Contrats supportés ajoutés après la ligne de base de v1.0.0

Cette section applique la règle du § 3.1 : une évolution compatible de la 1.x
**peut** ajouter un contrat public supporté, sous la discipline de mineure du
§ 6, sans modifier rétroactivement ce que la ligne de base de v1.0.0
contenait.

Elle énumère, et c'est sa seule fonction, les contrats publics supportés
**ajoutés après** cette ligne de base.

**Contrats de projection ajoutés après v1.0.0**

```text
docs/specs/run-descriptors-machine.md
docs/specs/run-activity-machine.md
```

```text
CONTRATS SUPPORTÉS EXISTANTS   inchangés
NOUVEAUX CONTRATS SUPPORTÉS    découverte sémantique machine des runs
                               activité durable machine d'un run
CHANGEMENT DE COMPATIBILITÉ    additif
APPARTENANCE À LA LIGNE DE BASE DE v1.0.0   inchangée
```

Ces deux documents deviennent des contrats publics supportés à compter de la
version de paquet qui les publie. Ils ne rejoignent **pas** la ligne de base de
v1.0.0, qui reste historiquement fixée à ses huit documents.

```text
LIGNE DE BASE DE v1.0.0   toujours exactement 8 documents
```

Aucun contrat public supporté existant n'est modifié, réinterprété ni retiré par
cet ajout. En particulier, `docs/specs/run-inventory-machine.md`,
`docs/specs/invocation-outcome.md` et
`docs/specs/invocation-outcome-machine.md` conservent leur autorité, leur sens
et leurs frontières inchangés.

**Contrat de domaine ajouté après v1.1.0**

```text
docs/specs/production-intent.md
```

```text
CONTRATS SUPPORTÉS EXISTANTS   inchangés
NOUVEAU CONTRAT SUPPORTÉ       intention de production d'un run
CHANGEMENT DE COMPATIBILITÉ    additif
APPARTENANCE À LA LIGNE DE BASE DE v1.0.0   inchangée
```

Ce document devient un contrat public supporté à compter de la version de paquet
qui le publie. Il ne rejoint **pas** la ligne de base de v1.0.0, qui reste
historiquement fixée à ses huit documents.

Aucun contrat public supporté existant n'est modifié, réinterprété ni retiré par
cet ajout. `docs/specs/run-descriptors-machine.md` conserve son autorité, son
sens et ses frontières inchangés. `docs/specs/run-activity-machine.md` demeure
l'autorité de sa propre surface : l'évolution de ses axes de version propres lui
appartient, et relève du § 6 et du § 8, non de la présente énumération.

**Contrats ratifiés après v1.2.0 — IMPLÉMENTÉS EN LIGNE DE BASE SOURCE, NON PUBLIÉS**

```text
docs/specs/run-invocation-accounting-machine.md
docs/specs/run-operational-state-machine.md
docs/specs/operation-invocation-effect-machine.md
```

```text
AUTORITÉ NORMATIVE                      RATIFIÉE PAR L'HUMAIN
IMPLÉMENTATION                          PRÉSENTE DANS LA LIGNE DE BASE SOURCE
CONFORMITÉ DE CES TROIS CONTRATS        ÉTABLIE
PUBLICATION                             AUCUNE
APPARTENANCE À UNE LIGNE DE BASE
  SUPPORTÉE PUBLIÉE                     AUCUNE
CONTRATS SUPPORTÉS EXISTANTS            INCHANGÉS
JEU DE CONTRATS SUPPORTÉS DE v1.2.0     INCHANGÉ
APPARTENANCE À LA LIGNE DE BASE DE v1.0.0   inchangée
```

La version publiée courante du paquet — **1.2.0** — ne fournit aucune des trois
commandes. Une implémentation conforme existe dans la ligne de base source ;
aucune version publiée ne la contient.

**Portée exacte de « conformité établie ».** Elle porte sur ces trois contrats,
et sur eux seuls :

```text
CONFORMITÉ R1 · R2 · P                  ÉTABLIE
IDENTITÉ D'ÉCHEC D'INTÉGRATION
  PROPRE À CETTE IMPLÉMENTATION         AUCUNE ÉTABLIE
    au sens du protocole différentiel prédéclaré, par identité, sur
    campagnes complètes appariées — candidat contre autorité vierge
SUITE CANONIQUE D'INTÉGRATION           ROUGE ET INSTABLE
VÉRIFICATION COMPLÈTE DU DÉPÔT          NON
```

```text
CONFORMITÉ DE CONTRAT ÉTABLIE   ≠   VÉRIFICATION COMPLÈTE DU DÉPÔT
```

La suite canonique d'intégration reste **rouge et instable**. Selon le protocole
différentiel prédéclaré par identité, aucune identité d'échec propre à cette
implémentation n'a été établie.

Ce résultat est exactement celui-là, et rien de plus. Il ne vaut ni suite verte,
ni démonstration que cette implémentation serait sans effet sur la fréquence des
instabilités observées : le protocole compare des identités, il ne mesure pas des
fréquences. La vérification complète du dépôt reste non verte.

```text
AUCUNE IDENTITÉ PROPRE ÉTABLIE   ≠  suite verte
                                 ≠  absence d'effet sur la fréquence des
                                    instabilités observées
                                 ≠  vérification complète du dépôt
```

## 3.4.1 Quatre états, jamais trois

Un contrat traverse quatre états distincts, et la présente section n'en confond
aucun :

```text
1  PROPOSÉ · NON RATIFIÉ
   un document existe · aucune autorité humaine ne l'a retenu

2  CIBLE NORMATIVE RATIFIÉE PAR L'HUMAIN
   NON IMPLÉMENTÉE · NON PUBLIÉE
   l'autorité humaine a retenu le sens · aucun code ne le rend ·
   aucune version publiée ne le contient

2-BIS  IMPLÉMENTÉ EN LIGNE DE BASE SOURCE · CONFORME · NON PUBLIÉ
   l'autorité humaine a retenu le sens · une implémentation le rend dans la
   ligne de base source · sa conformité de contrat est établie ·
   aucune version publiée ne le contient

3  IMPLÉMENTÉ · CONFORME · CONTRAT PUBLIC SUPPORTÉ PUBLIÉ
   une implémentation le rend · sa conformité est établie ·
   une version publiée le contient
```

L'état intermédiaire porte le repère **2-bis** et non un nouveau numéro de
séquence : les états 1, 2 et 3 gardent leur identifiant et leur sens exacts, et
en particulier l'état publié reste l'**état 3**, celui qu'il a toujours été. Un
contrat déjà parvenu en état 3 n'est ni renuméroté, ni réinterprété.

```text
ORDRE   1  <  2  <  2-bis  <  3
```

```text
R1 · R2 · P   =  ÉTAT 2-BIS
```

Ils ne sont **pas** en état 3, et rien dans ce document ne doit se lire comme
tel. Le passage de 2-bis à 3 est un acte distinct — la version de paquet qui les
publie, énoncée ici à ce moment-là.

```text
ENTRÉE DU CODE DANS LA LIGNE DE BASE SOURCE   =  2  →  2-bis
PUBLICATION PAR UNE VERSION DE PAQUET         =  2-bis  →  3
```

**Repère non ratifié.** Le nom et le repère `2-bis` de cet état intermédiaire
sont une proposition matérialisée : la sémantique de l'état est retenue par
l'autorité humaine, sa désignation ne l'est pas encore.

## 3.4.2 Ce que la ratification ne fait pas

```text
RATIFICATION NORMATIVE
  ≠  implémentation
  ≠  conformité établie
  ≠  publication
  ≠  entrée dans une ligne de base supportée
  ≠  promesse de compatibilité opposable
```

Ces non-identités portent sur l'**acte** de ratification, jamais sur l'état
courant d'un contrat donné : que R1, R2 et P soient aujourd'hui implémentés et
conformes ne vient pas de leur ratification, mais d'actes distincts et
postérieurs.

Les commandes que ces documents décrivent — `ccr run-invocation-accounting`,
`ccr run-operational-state`, `ccr operation-effects` — ne sont **pas** fournies
par la version publiée courante du produit. Leur syntaxe est implémentée dans la
ligne de base source, et n'est pour autant le contrat public supporté d'aucune
version publiée.

```text
SURFACE IMPLÉMENTÉE EN LIGNE DE BASE SOURCE
  ≠  CONTRAT PUBLIC SUPPORTÉ PUBLIÉ
```

Un consommateur ne peut donc s'appuyer sur aucun des trois aujourd'hui. Ils
n'entreront dans le contrat public supporté qu'à la version de paquet qui les
publie, et cette entrée sera énoncée ici à ce moment-là.

Ce qui vaut du code vaut du document : la présence de ces spécifications dans
Git depuis leur ratification n'a jamais valu publication de contrat, et leur
implémentation dans la ligne de base source ne la vaut pas davantage.

```text
DOCUMENT NORMATIF PRÉSENT DANS GIT   ≠  CONTRAT PUBLIC SUPPORTÉ PUBLIÉ
CODE PRÉSENT DANS GIT                ≠  CONTRAT PUBLIC SUPPORTÉ PUBLIÉ
```

## 3.4.3 Ce que la ratification ne change pas

Aucun contrat public supporté existant n'est modifié, réinterprété ni retiré.
`docs/specs/run-inventory-machine.md`,
`docs/specs/run-descriptors-machine.md`, `docs/specs/run-activity-machine.md`,
`docs/specs/invocation-outcome.md`, `docs/specs/invocation-outcome-machine.md` et
`docs/specs/production-intent.md` conservent leur autorité, leur sens et leurs
frontières inchangés. En particulier :

```text
run-activity-machine.md         demeure l'autorité de l'activité procédurale
                                ACTIVITÉ ≠ ISSUE D'INVOCATION reste intact
invocation-outcome*.md          demeurent l'autorité des faits d'issue persistés
                                un tableau vide reste une cardinalité
production-intent.md            demeure l'autorité de l'intention de production
                                aucune des trois cibles ne la reprojette
```

La ligne de base de v1.0.0 reste historiquement fixée à ses huit documents.

```text
LIGNE DE BASE DE v1.0.0   toujours exactement 8 documents
```

`docs/specs/run-operational-state-machine.md` **se réfère** au vocabulaire de
rôle publié par `docs/specs/run-activity-machine.md` § 10, sans le redéfinir ni
l'étendre. Une référence n'est pas une modification : l'évolution de ce
vocabulaire demeure gouvernée par les axes de version du contrat qui le possède.

```text
RÉFÉRENCE À UN VOCABULAIRE PUBLIC EXISTANT
  ≠  extension du contrat qui le possède
```

La sortie humaine de `ccr status` n'acquiert aucune promesse de compatibilité du
fait de cette ratification : elle reste orientation et découverte au sens du
§ 2.1. Ratifier R1, R2 et P ne promeut aucune sortie humaine en contrat machine
supporté.

```text
AJOUT D'UN CONTRAT SUPPORTÉ
  ≠  remplacement d'un contrat supporté existant
  ≠  réinterprétation d'un contrat supporté existant
  ≠  modification rétroactive d'une ligne de base historique
```

Cette section n'énonce aucune règle de compatibilité nouvelle. Les règles de
majeure, de mineure et de correctif restent celles des § 5, § 6 et § 7, et
gouvernent ces contrats comme tous les autres.

---

# 4. Garantie 1.x

## 4.1 Ce que CCR peut faire dans 1.x

```text
évoluer de façon additive
ajouter une capacité publique supportée rétrocompatible
faire évoluer un contrat public supporté de façon compatible
corriger un défaut
clarifier un sens déjà établi, sans changer ce sens
```

## 4.2 Ce que CCR ne doit pas faire

```text
rompre silencieusement un contrat public supporté
```

## 4.3 La promesse de 1.0, exactement

```text
v1.0.0   les contrats publics supportés explicitement énumérés
         deviennent une ligne de base de compatibilité
         au niveau du paquet

v1.0.0   ≠ gel de tout détail d'implémentation courant
```

---

# 5. Majeure de paquet

Une **majeure de paquet** est requise pour tout changement **intentionnellement
incompatible** d'un contrat public supporté.

Constitue une rupture de contrat public, lorsque le cas s'applique :

```text
modifier matériellement le sens borné d'un champ ou d'un jeton contractuel
   existant

réaffecter le rôle d'un champ contractuel existant

retirer une capacité publique supportée existante, ou la rendre indisponible,
   d'une façon qui rompt les consommateurs conformes existants

changer de façon incompatible un invariant de cardinalité établi

changer de façon incompatible une frontière d'autorité établie

changer de façon incompatible une sémantique établie de zéro,
   d'absence ou d'échec

violer autrement une garantie de compatibilité explicite
   énoncée par le contrat public supporté qui la possède
```

## 5.1 Retrait

```text
RETRAIT D'UNE CAPACITÉ PUBLIQUE SUPPORTÉE
  = incompatible dès lors que des consommateurs conformes existants
    ne peuvent plus s'appuyer sur cette capacité inchangée
```

Fournir un remplacement ou un chemin de migration **ne rend pas** à lui seul le
retrait de la capacité existante compatible.

---

# 6. Mineure de paquet

Une **mineure de paquet** est :

```text
l'ajout rétrocompatible d'une capacité publique supportée
   OU
l'évolution rétrocompatible de contrats publics supportés
```

Une nouvelle version propre à un contrat **peut** être introduite dans 1.x, à
condition que les contrats publics supportés existants restent compatibles pour
les consommateurs conformes.

```text
NOUVELLE VERSION DE CONTRAT   ≠   MAJEURE DE PAQUET AUTOMATIQUE
```

---

# 7. Correctif de paquet

Un **correctif de paquet** est :

```text
la correction rétrocompatible d'un défaut
   OU
la clarification d'un sens déjà établi, qui préserve ce sens
```

Un correctif **n'introduit aucune** capacité publique supportée nouvelle.

Une prétendue « clarification » qui change matériellement le sens d'un contrat
public supporté existant **n'est pas** une clarification au sens de ce
document.

```text
NOMMER UN CHANGEMENT « CLARIFICATION »
  ne l'emporte jamais sur son effet réel de compatibilité
```

---

# 8. Axes de version propres aux contrats

```text
VERSION DE PAQUET
  ≠  version de contrat sémantique
  ≠  version de représentation machine
  ≠  version d'enregistrement source / de schéma
  ≠  toute autre version explicitement possédée par un contrat
```

Les axes propres aux contrats :

```text
conservent leur signification propre et indépendante
ne sont PAS des alias du versionnement sémantique du paquet
ne déterminent PAS mécaniquement la majeure, la mineure
   ou le correctif du paquet
```

Par conséquent :

```text
NOUVELLE VERSION DE CONTRAT
+ ligne de base publique supportée restant compatible
   →  PEUT rester dans la 1.x du paquet
```

Et réciproquement :

```text
RUPTURE D'UN CONTRAT PUBLIC SUPPORTÉ
   →  exige une évolution majeure du paquet
```

y compris lorsque le contrat concerné possède son propre axe de version
interne.

---

# 9. Autorité propre aux contrats

Le contrat public supporté qui possède une surface **reste l'autorité** pour
les questions de compatibilité internes à cette surface.

Le versionnement sémantique du paquet **ne tranche pas silencieusement** une
question qu'un contrat laisse explicitement ouverte.

En particulier, il ne décide **pas** automatiquement :

```text
le traitement des futurs champs optionnels
le traitement des champs inconnus
la politique de compatibilité ascendante
la compatibilité des champs additifs
```

lorsque le contrat qui les possède laisse délibérément ces questions ouvertes.

---

# 10. Interprétation historique

Lorsqu'un contrat public supporté gouverne explicitement des enregistrements
historiques, des versions historiques ou des règles d'interprétation, **ces
règles restent gouvernées par ce contrat**.

La persistance interne qui n'est pas désignée comme publique **n'est pas
promue en API** par la politique 1.x.

---

# 11. Ce qui n'est pas promis

```text
aucun support éternel

aucun détail d'implémentation immuable

aucune garantie que tout champ additif soit compatible

aucune garantie que les champs inconnus soient toujours acceptés

aucune garantie que les champs inconnus soient toujours refusés

aucune promotion de tout format interne historique en format public

aucune promotion de tout jeton de présentation CLI en API stable

aucune promotion de toute phrase du README en énoncé normatif

aucune entrée automatique d'un artefact du dépôt
   dans la ligne de base de v1.0.0
```

---

**Une version de paquet est un signal, pas une sémantique.** Elle dit ce que
CCR s'engage à préserver ; ce que les surfaces signifient reste dit par les
contrats qui les possèdent.
