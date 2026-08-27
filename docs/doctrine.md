# CCR — Doctrine

## Ce que CCR affirme, et ce qu'il refuse d'affirmer

**Projet :** CCR — Contradictory Cross-Review / Contre-expertise croisée

---

# 0. Statut et fonction de ce document

## 0.1 Ce que ce document est

La doctrine normative de CCR. Une personne découvrant le projet devrait pouvoir
lire ce seul document et savoir : ce qu'est CCR, ce qu'il sait établir, ce qu'il
refuse d'établir, et où commence la recherche.

Pour toute question normative, ce document fait foi. Le README oriente ; les
spécifications de [`specs/`](specs/) décrivent les contrats techniques courants.

## 0.2 Ce que ce document n'est pas

```text
pas un contrat d'implémentation
pas une spécification de moteur
pas un plan de code
pas un manuel d'utilisation
pas un catalogue d'identifiants, de commandes ou de surfaces
```

## 0.3 Portée

Cette doctrine décrit l'état **courant** du dispositif. Elle est destinée à
évoluer par décisions explicites, et non par dérive.

---

# 1. Mission de CCR

> **CCR organise une contre-expertise structurée entre expertises distinctes.**

Le dispositif doit :

```text
préserver la pluralité des positions
rendre les désaccords et les limites inspectables
conserver la provenance
permettre l'intervention humaine à tout moment
empêcher que l'orchestration devienne silencieusement
l'autorité intellectuelle finale
```

Le principe fondateur reste :

> **La preuve l'emporte sur l'accord.**

Deux modèles qui disent la même chose n'ont rien démontré. CCR ne transforme
jamais une concordance en vérité.

Ces cinq devoirs se réalisent, dans l'architecture livrée, par des conséquences
qui ne les remplacent pas : préserver la continuité native de chaque expert, tenir
un état canonique extérieur aux conversations, transférer sans reformuler ni
arbitrer, rendre visible ce qui est su comme ce qui ne l'est pas, et laisser la
décision normative à l'humain.

## 1.1 Ce que CCR n'est pas

CCR n'est pas un système automatique de vérité.

Il sait structurer une controverse, conserver des matériaux, enregistrer qu'un
acteur a versé un matériau au débat à propos d'une cible, et représenter une
réconciliation. Rien de tout cela ne le rend juge du fond. Ce
qu'il gagne en structure, il ne le gagne pas en autorité intellectuelle :
structurer un désaccord n'est pas le trancher, et proposer une réconciliation
n'est pas la décider.

## 1.2 Définition courante

> CCR est un protocole de production fiable de connaissance sur un projet, dans
> lequel des rôles d'expertise indépendants sont affectés à des sessions IA
> natives persistantes sans confondre l'identité de l'expert avec le fournisseur
> qui l'exécute. Les conversations natives fournissent la continuité cognitive ;
> CCR conserve extérieurement la continuité épistémique, structure et conserve les
> désaccords et les éléments qu'on leur oppose sans en juger le fond, propose sans
> décider et enregistre les effets humains explicites qui bornent un débat,
> gouverne explicitement les appels qu'il déclenche, présente l'état sans le
> déformer, et maintient l'autorité humaine sur les décisions normatives comme sur
> les limites de consommation.

---

# 2. Modèle d'autorité

Le modèle d'autorité distingue quatre catégories : l'autorité **normative**
humaine, l'autorité **factuelle** de la preuve et du code, l'autorité
**argumentative** des experts, et l'autorité **procédurale** de CCR. Elles sont
hiérarchisées et ne se recouvrent pas.

Les deux rôles d'expert exercent la même catégorie d'autorité — argumentative —
et restent distincts l'un de l'autre.

| Autorité | Catégorie | Domaine | Portée |
|---|---|---|---|
| **Humain** | normative | décisions normatives, arbitrages de troisième option, budgets, périmètre | finale |
| **Preuve / code** | factuelle | affirmations factuelles démontrables | contraignante sur les faits |
| **Expert Auteur** | argumentative | expertise, proposition, analyse | argumentative |
| **Expert Challenger** | argumentative | contradiction, stress-test, contre-expertise | argumentative |
| **CCR** | procédurale | orchestrer, conserver, structurer, exposer, gouverner | procédurale |

## 2.1 CCR n'est pas arbitre normatif

CCR peut transférer, encadrer, structurer, compter, refuser et présenter. Il ne
peut pas :

```text
résumer un désaccord jusqu'à le faire disparaître
réécrire la position d'un expert
désigner un gagnant
convertir un consensus en fait
modifier une décision humaine
```

Lorsqu'une situation exige une norme nouvelle ou une troisième option :

```text
HUMAN DECISION REQUIRED
```

Cet interdit a une forme précise : une production attribuée à CCR peut **proposer**
une réconciliation, et cette production n'a aucun effet par elle-même.

```text
PROPOSITION CCR   ≠  AUTORITÉ HUMAINE
SORTIE DE MODÈLE  ≠  AUTORITÉ HUMAINE
```

## 2.2 Une autorité humaine ne vaut que pour son périmètre

Une décision humaine fournit une autorité suffisante **dans le périmètre exact
qu'elle arbitre**, et nulle part ailleurs. Hors de ce périmètre, il n'y a pas
d'effet d'autorité — ni positif, ni négatif.

```text
DÉCISION HUMAINE  ≠  ACCORD DES EXPERTS
```

Une décision humaine ne réécrit jamais l'histoire des experts, et ne leur prête
jamais rétroactivement un accord qu'ils n'ont pas exprimé.

Cette borne est opérationnelle : un acte humain de réconciliation porte un
périmètre **explicite et énuméré**, et son effet ne dépasse jamais les unités qu'il
nomme.

```text
EFFET HORS PÉRIMÈTRE  =  NON
```

## 2.3 L'humain gouverne aussi la ressource

L'autorité humaine ne porte pas seulement sur la doctrine produit, mais sur la
quantité de ressource que CCR est autorisé à mobiliser.

> **CCR ne peut jamais augmenter implicitement son propre budget.**

L'automatisation peut refuser, avertir, exiger une approbation ou autoriser. Elle
ne peut pas relever son propre plafond parce qu'elle estime avoir besoin de
travailler davantage.

---

# 3. Modèle des experts et des fournisseurs

## 3.1 L'invariant

```text
rôle d'expert   author | challenger        identité du protocole
fournisseur     le moteur qui l'exécute    affectation technique
```

> **RÔLE ≠ FOURNISSEUR.**

Ces deux ensembles ne se recouvrent jamais et ne se déduisent jamais l'un de
l'autre. Le fournisseur ne porte jamais l'identité cognitive du rôle.

## 3.2 La clé du slot *est* son rôle

Un expert ne porte pas un champ « rôle » : il **est** auteur ou il **est**
challenger. La différence n'est pas cosmétique — un champ peut valoir deux fois la
même chose, une clé non. La forme empêche ainsi la duplication ; une validation
distincte empêche l'absence.

## 3.3 Same-provider est légitime

Deux rôles peuvent être exécutés par le même moteur, à une condition absolue :
**les sessions natives sont distinctes**. Deux rôles actifs ne partagent jamais
implicitement une même conversation native — une conversation unique pour deux
rôles produirait une indépendance fictive.

## 3.4 Aucun rebind transparent

Une affectation ne change pas pendant la vie cognitive d'un rôle dans un run.
Déplacer un rôle d'un moteur à un autre n'est pas une reprise : c'est une rupture
de continuité cognitive, qui devrait se déclarer comme telle.

## 3.5 Faits fournisseur et affectation d'expert

```text
faits fournisseur    ce qui est installé et authentifié sur le poste
affectation          quel moteur exécute quel rôle dans CE run
```

Un champ nommé d'après un fournisseur n'est pas un défaut lorsqu'il décrit une
installation. Il en devient un lorsqu'il désigne un acteur du protocole.

## 3.6 L'alternance est persistée, jamais déduite

La direction d'un transfert ne dépend ni du fournisseur, ni de l'ordre de création
des sessions, ni d'une règle du type « l'autre moteur ». CCR persiste
explicitement le rôle dont la prochaine réponse sera transférée.

Le curseur n'avance qu'à la finalisation canonique d'un transfert dont la réponse
est journalisée — jamais au lancement, jamais sur un compteur, jamais après un
échec. Un message humain intercalé ne le déplace pas : intervenir n'est pas prendre
le tour d'un expert.

> Une règle d'alternance qu'il faut reconstruire depuis l'historique n'est pas une
> règle : c'est une interprétation.

---

# 4. Sessions, continuités et état persisté

## 4.1 Les deux continuités

```text
continuité cognitive     portée par la session native du fournisseur
continuité épistémique   portée par l'état persisté CCR
```

Elles coopèrent. Elles ne sont **jamais** équivalentes, et ne se substituent pas
l'une à l'autre.

| | Contient | Ne contient pas |
|---|---|---|
| Session native | le raisonnement, le contexte accumulé, la mémoire de l'échange | la provenance CCR, les décisions, la gouvernance |
| État CCR | provenance, faits canoniques, décisions, opérations, gouvernance, identité de run | le raisonnement des experts |

Une conversation d'agent n'est pas la base de données de CCR. Réciproquement,
l'état CCR ne prétend pas reconstruire la continuité cognitive complète : il ne la
contient pas, et n'a jamais promis de la contenir.

Cette distinction ne dépend d'aucun fournisseur ni d'aucun protocole de session
particulier.

## 4.2 Ce qu'un crash ne doit jamais détruire

```text
l'identité du run
les identités de session natives
tout fait canonique déjà écrit
la capacité de reprendre le run
```

La formulation est délibérément donnée **par classe** et non par énumération de
journaux : une liste qu'il faut allonger à chaque moteur nouveau n'est pas une
norme, c'est un inventaire.

Un arrêt brutal ne produit ni rejeu silencieux, ni conclusion inventée : une
opération engagée dont l'issue est inconnue reste inconnue, et se donne à lire
comme telle.

## 4.3 Génération d'un run

Un run appartient à une génération, déterminée à sa création et lue sur son
manifeste. Le mode ne change jamais.

Une opération autorisée sur un run historique écrit dans le schéma de ce run :
**une mutation n'emporte pas une migration**. Rendre l'histoire mixte impossible
vaut mieux que marquer chaque ligne — le marqueur suggérerait qu'une histoire
puisse porter deux générations, ce qui est exactement l'interdit.

## 4.4 Lire un run historique sans inventer

Un run antérieur se lit selon ce qu'il porte réellement. Aucun rôle n'est inventé
pour le rendre projetable ; aucune valeur « indéterminé » n'est créée pour combler
une absence. Lorsque les rôles historiques ne se distinguent pas, le run reste
lisible mais interdit toute opération produisant un tour d'expert nouveau.

> Nommer les acteurs d'un run passé est une lecture. Prétendre qu'il a suivi des
> règles qui n'existaient pas encore serait une falsification.

## 4.5 Un run appartient à un seul écrivain

Deux processus CCR ne mutent jamais le même run concurremment. Le verrou est local,
et un verrou périmé se traite explicitement — jamais par contournement silencieux.

---

# 5. Attribution

## 5.1 Le principe

> **L'attribution est multi-dimensionnelle.**

Des questions d'attribution distinctes ne doivent pas être fusionnées par commodité
terminologique. Chacune se demande séparément, et la réponse à l'une ne se déduit
jamais de la réponse à une autre.

Les dimensions que la doctrine doit permettre de distinguer, lorsqu'elles sont
pertinentes :

```text
QUI ACCOMPLIT         l'acteur qui porte l'acte dans le protocole
ORIGINE SÉMANTIQUE    qui est l'auteur du sens de ce qui est enregistré
QUI ENREGISTRE        qui tient le journal
EXÉCUTANT TECHNIQUE   quel moteur réalise matériellement une opération assistée
PROVENANCE            d'où vient la matière dont il est question
ÉNONCÉ                à qui un énoncé est attribué
INFÉRENCE             à qui ou à quoi une inférence est attribuée
```

Ce sont des **questions**, jamais une énumération de valeurs.

## 5.2 Les non-équivalences d'attribution

```text
qui enregistre        ≠  qui est l'auteur sémantique
exécutant technique   ≠  origine sémantique
provenance d'un       ≠  attribution d'un énoncé
matériau
```

Un journal tenu par un tiers n'attribue pas à ce tiers ce qu'il consigne. CCR peut
enregistrer un fait humain sans devenir l'auteur sémantique de ce fait. Un moteur
qui exécute une opération n'est pas l'auteur de ce qui en résulte.

La réconciliation en rend deux autres nécessaires :

```text
ACCEPTATION HUMAINE  ≠  PATERNITÉ HUMAINE DU RAISONNEMENT CCR
ACCEPTATION HUMAINE  ≠  VALIDATION RÉTROACTIVE DU RAISONNEMENT CCR
```

Une lecture distingue toujours quatre choses : le contenu proposé par CCR, la
dérivation qui l'a produit, le contenu de décision humain, et les effets humains.
Le raisonnement de CCR n'est jamais attribué à l'humain — pas même lorsque celui-ci
fait sien le contenu proposé.

## 5.3 Les vocabulaires appartiennent aux contrats

La doctrine pose le principe de séparation. Elle **ne ferme pas** une union
universelle de valeurs admissibles.

Chaque contrat de moteur :

```text
1  définit les dimensions qu'il emploie
2  ferme explicitement les valeurs admises pour chacune
3  ne fusionne pas deux dimensions distinctes sous un même mot
4  rend explicites les correspondances et les différences
```

> **Principe commun d'attribution ≠ vocabulaire d'attribution fermé globalement.**

Conséquence directe, et opposable : **une valeur d'origine sémantique locale à un
moteur n'est pas automatiquement une valeur transversale CCR.** Deux moteurs
peuvent employer le même mot pour deux choses différentes ; la doctrine leur
demande de le dire, pas de s'aligner.

## 5.4 Provenance

Tout fait contrôlé par CCR est attribuable. Les trois questions historiques — qui
agit dans le protocole, avec quel moteur, dans quelle continuité native —
demeurent, et prennent place parmi les dimensions du §5.1.

L'identité métier ne se déduit jamais depuis l'identité technique : cela exigerait
une jointure vers une configuration lisible, ce qui n'est pas garanti au moment où
la provenance importe le plus. Et certains faits impliquent deux rôles — un
identifiant unique ne peut pas les porter.

La provenance déclarée d'un acte dit **d'où il se réclame**. Elle ne le rend ni
fondé, ni vrai.

```text
PROVENANCE  ≠  AUTORITÉ
```

## 5.5 Auditable n'est pas produit par la source

Qu'un énoncé soit ancré dans un texte original le rend **auditable** : quiconque
peut lire l'original et juger. Cela ne le rend pas **produit par sa source**.

```text
AUDITABLE  ≠  PRODUIT PAR LA SOURCE
TRAÇABLE   ≠  SÉMANTIQUEMENT PRODUIT PAR LA SOURCE
```

Le choix de ce qui compte comme l'énoncé, sa formulation et sa portée viennent de
celui qui transcrit. Une trace, un ancrage, une provenance ou un matériau
résolvable ne transforment jamais une lecture humaine en production directe de la
source.

---

# 6. Findings, décisions, remédiations

## 6.1 L'invariant

```text
Finding       constat · problème · contradiction · faiblesse
Remediation   choix d'action pour modifier la situation
```

> **CCR ne transforme jamais automatiquement un finding en remediation.**

« Ceci est mauvais » n'implique pas « voici ce qu'il faut faire ». Le second énoncé
engage une préférence, un coût et un périmètre : il relève de la décision, pas du
constat.

L'existence d'un constat valide ne signifie donc pas que sa correction est
autorisée, définie, ou exécutée. Cette séparation vaut pour le travail produit
comme pour les dispositifs qui le vérifient.

## 6.2 Trois natures de désaccord

```text
empirique       tranché par la preuve
interprétatif   tranché par explicitation du cadre
normatif        tranché par l'humain
```

Les confondre produit soit un arbitrage illégitime, soit une recherche de preuve
sans objet.

## 6.3 Les décisions ne vivent pas seulement dans un transcript

Une décision normative dont CCR dépendra ensuite ne doit pas exister uniquement à
l'intérieur d'une conversation d'agent. Elle est enregistrée comme fait CCR,
attribuable et durable.

---

# 7. Ce qu'un système peut inférer

## 7.1 Attribution n'est pas approbation

CCR peut être autoritaire sur le fait **qu'un énoncé, une relation, une inférence
ou un acte a été attribué ou enregistré d'une certaine manière**, à partir de tels
éléments, dans tel contexte.

Il ne devient pas, de ce seul fait, autoritaire sur la vérité intellectuelle du
contenu attribué.

```text
ATTRIBUTION     ≠  APPROBATION
ENREGISTREMENT  ≠  VALIDATION DU FOND
```

Ainsi, « CCR a inféré une divergence entre A et B sur X » n'est jamais
silencieusement équivalent à « A et B sont en désaccord sur X ».

Aucune promotion implicite d'une inférence du système en énoncé d'une source.
Aucune règle du type « au-delà de tel seuil de confiance, c'est vrai ». Aucun juge
automatique.

## 7.2 L'autorité d'inférence est bornée par ce qui a été observé

Un système ne doit pas présenter comme observé, attribué ou inféré depuis son
corpus ce qu'il n'a pas effectivement reçu dans le périmètre gouverné.

Qu'un objet existe et soit valide **au moment où l'on enregistre l'inférence** ne
suffit pas : il devait faire partie de ce qui a été soumis. Un élément apparu
pendant qu'une opération était en cours ne devient jamais rétroactivement un
élément vu.

```text
EXISTE MAINTENANT  ≠  A ÉTÉ SOUMIS
```

Sans cette borne, une dérivation pourrait affirmer des éléments qu'aucun
raisonnement n'a jamais examinés — une provenance mensongère, que la seule validité
formelle ne détecte pas.

## 7.3 Ce que cette borne ne dit pas

Elle porte sur ce que le système a le droit d'**affirmer**, jamais sur ce qui
existe.

```text
NON OBSERVÉ  ≠  ABSENT DU MONDE
```

CCR ne conclut jamais de sa propre ignorance à l'inexistence de ce qu'il n'a pas
vu.

---

# 8. Controverse : structuration et non-clôture

## 8.1 Ce que CCR peut établir

CCR peut structurer une controverse, en conserver les entrées, et être autoritaire
sur le fait qu'il a produit ou enregistré une certaine structuration ou une
certaine inférence.

Cela ne rend la controverse ni vraie, ni résolue, ni close.

```text
RELATION INFÉRÉE PAR CCR  ≠  VÉRITÉ DE LA RELATION
CONTROVERSE STRUCTURÉE    ≠  VÉRITÉ DU FOND
```

## 8.2 Ce qui ne clôt pas une controverse

Une controverse ne cesse pas d'être portée sur la base du silence, de l'absence
d'activité, ou d'une inférence de compatibilité. Une évolution exige un événement
explicite d'autorité suffisante, relativement à ce qui est concerné.

```text
SILENCE                          ≠  CLÔTURE
ABSENCE D'ACTIVITÉ RÉCENTE       ≠  CLÔTURE
RETRAIT D'UNE POSITION           ≠  CLÔTURE AUTOMATIQUE DE LA CONTROVERSE
ACCORD INFÉRÉ PAR LE SYSTÈME     ≠  CLÔTURE
ARBITRAGE HUMAIN                 ≠  ACCORD RÉTROACTIF DES EXPERTS
DÉCISION HUMAINE                 ≠  ACCORD DES EXPERTS
```

Un retrait de position est un fait attribué à sa source ; il porte sur cette
position et non sur la controverse entière. Un abandon d'objection est
enregistrable comme énoncé attribué ; il ne vaut aucune convergence.

La liste couvre aussi les objets de la réconciliation : une proposition, une
détection, une sortie de modèle, une couverture structurelle complète et une
réponse humaine seule ne clôturent rien (§18.3).

## 8.3 Le maintien du désaccord

Le maintien d'un désaccord est un **résultat légitime**, jamais un échec du
dispositif.

`CONVERGED` reste **réservé**. Un accord entre deux moteurs n'est pas une
convergence, et aucune version ne doit assigner cet état sans avoir d'abord défini
ce qu'une convergence démontre.

La doctrine énonce ici ce qui **ne clôt pas**. Elle ne crée aucun état positif
canonique de désaccord persistant : il n'en existe aucun (§20).

---

# 9. Rétention et adduction

## 9.1 Deux actes, jamais un seul

> **Retenir n'est pas verser au débat.**

Qu'un dispositif observe, retienne, enregistre, identifie ou possède un élément ne
signifie pas qu'un acteur l'a opposé à quelque chose.

```text
ENREGISTRÉ  ≠  VERSÉ AU DÉBAT
DÉTENU      ≠  VERSÉ AU DÉBAT
```

Le premier acte dit ce que le dispositif conserve. Le second engage une position.
Les confondre ferait d'un classement une prise de position, et prêterait à
quiconque enregistre une opinion qu'il n'a pas exprimée.

## 9.2 L'adduction

Conceptuellement, **adduire** est l'acte historique de verser au débat un élément
déjà enregistré, à propos d'une cible, avec une orientation argumentative, à une
date, sous une provenance.

Cet énoncé ne dit **rien** sur qui a créé, écrit, fourni ou possédé l'élément. La
provenance de la matière et l'origine sémantique de l'acte sont deux dimensions
distinctes (§5.1).

## 9.3 L'orientation déclarée

Une orientation déclare la relation que l'acteur donne entre un élément et une
cible. Elle ne constitue pas un jugement du fond.

```text
SOUTIEN                        ≠  ÉTABLIT QUE C'EST VRAI
OBJECTION                      ≠  ÉTABLIT QUE C'EST FAUX
AUCUNE ORIENTATION DÉCLARÉE    ≠  SANS PERTINENCE
```

L'absence d'orientation déclarée est une **valeur**, jamais un silence : un champ
absent permettrait de la reconstruire comme une position cachée.

## 9.4 Deux positions contraires coexistent

Deux actes contraires portant sur le même élément et la même cible sont deux faits.
Aucun n'efface l'autre, aucun n'est préféré, et aucune préséance n'est calculée
entre eux. Compter n'est pas trancher.

---

# 10. Validation de forme et validation de fond

## 10.1 Le principe

> **Validation déterministe ≠ validation du fond.**

Une validation déterministe peut établir, selon ce que le contrat définit :

```text
forme · identité · périmètre · liaison · résolvabilité
cohérence structurelle · contraintes de représentation
```

Elle ne suffit jamais à établir :

```text
pertinence · crédibilité · fiabilité · suffisance · poids
vérité · fausseté · gagnant · préférence
```

```text
REPRÉSENTATION VALIDE  ≠  CORRECT SUR LE FOND
```

## 10.2 Ce qu'un succès de validation autorise à dire

Qu'un élément a passé les contrôles que le dispositif sait réellement faire. Rien
de plus. Un succès complet établit qu'une proposition est **structurellement
recevable** ; jamais qu'elle est convaincante, ni que ce qu'elle affirme est
correct.

## 10.3 Ce qu'un échec de vérifiabilité ne dit pas

Ne pas pouvoir vérifier maintenant n'est pas une réfutation.

```text
NON VÉRIFIABLE  ≠  FAUX
NON OBSERVÉ     ≠  ABSENT
INCONNU         ≠  FAUX
```

La vérifiabilité décrit ce que le dispositif a pu constater, jamais une qualité de
la pièce.

---

# 11. Assistance par modèle

## 11.1 Ce qu'une inférence assistée est

Un modèle peut produire une inférence attribuée, à l'intérieur d'un protocole
gouverné : geste humain explicite, périmètre explicite, engagement et gouvernance
d'usage applicables, validation déterministe de ce qui est rendu avant persistance,
attribution de la sortie, aucun jugement automatique du fond.

CCR est alors autoritaire sur le fait qu'il a produit et enregistré cette
inférence, dans ce contexte, à partir de ces éléments.

## 11.2 Ce qu'elle n'est pas

```text
ASSISTÉ PAR MODÈLE   ≠  VÉRITÉ DU MODÈLE
FOURNISSEUR          ≠  ORIGINE SÉMANTIQUE
EXÉCUTION RÉUSSIE    ≠  INFÉRENCE VRAIE
```

Ni l'identité du moteur, ni le fait que l'appel ait abouti ne rendent l'inférence
vraie. Le fournisseur vit dans les autorités de gouvernance ; il n'apparaît jamais
comme auteur de ce qui est enregistré.

## 11.3 Rien ne se déclenche seul

Une inférence assistée procède d'un geste explicite. Aucun tour, aucune lecture,
aucune présentation, aucun rafraîchissement, aucune mutation ordinaire ne la
produit.

---

# 12. Modèle de preuve et classes d'évidence

## 12.1 La grille

| Classe | Signification |
|---|---|
| `REAL_NOW` | exécuté contre les dispositifs réels pendant la validation |
| `HISTORICAL_REAL_FROZEN` | exécuté en réel sur un composant depuis gelé — provenance citée |
| `AUTOMATED_REAL_PROCESS` | processus, sockets, fichiers réels ; fournisseur doublé |
| `FIXTURE` | exécuté contre un double contrôlé |
| `STATIC` | établi par lecture de code ou test d'architecture |
| `MONITORED` | comportement connu, observé, ni corrigé ni ignoré |
| `NOT_TESTED` | non vérifié — motif obligatoire |

Ces classes qualifient la **validation d'une implémentation**. Elles ne constituent
aucune taxonomie des éléments qu'un expert oppose dans un argument, et ne doivent
jamais être réemployées comme telle.

```text
CLASSES DE PREUVE DE VALIDATION  ≠  MATÉRIAUX DE L'EVIDENCE ENGINE
CLASSES DE PREUVE DE VALIDATION  ≠  TAXONOMIE ARGUMENTATIVE
```

## 12.2 Les interdits

> **Les classes ne sont jamais silencieusement confondues.**

```text
une FIXTURE ne devient jamais REAL parce qu'elle est convaincante
NOT_TESTED ne devient jamais PASS
une absence d'observation ne devient jamais un zéro
```

## 12.3 Proportionnalité

Une classe de preuve ne doit jamais dépasser ce qui a effectivement été observé.
Une observation réelle sur un chemin ne promeut pas les chemins voisins : le reste
demeure `FIXTURE`, `STATIC` ou `NOT_TESTED` selon ce qui a réellement eu lieu.

`HISTORICAL_REAL_FROZEN` n'est pas `NOT_TESTED` : la preuve existe, elle a été
acquise en réel, et le composant n'a pas bougé. Elle se republie avec sa provenance
exacte, jamais en la rejouant pour paraître récente.

## 12.4 Formulation en cas de manque

```text
IMPLEMENTED
NOT EMPIRICALLY VERIFIED
```

Un critère `NOT_TESTED` interdit de déclarer `DONE`.

## 12.5 Les validations consomment de la ressource

Toute validation utilisant un dispositif fournisseur authentifié est potentiellement
consommatrice jusqu'à preuve du contraire. Un gate à budget contrôlé ne lance jamais
une campagne dont le coût maximal n'a pas été cartographié.

C'est une règle méthodologique, pas une préférence : elle a été apprise en la
violant.

---

# 13. Invocation, usage, coût, quota

## 13.1 Trois niveaux de vérité, jamais fusionnés

```text
Invocation        ce que CCR a déclenché         comptable exactement
UsageObservation  ce qui a été observé           provenance obligatoire
CostEstimate      ce qui s'en dérive             estimation versionnée
```

Trois autorités distinctes. **Aucune vue fusionnée.**

## 13.2 Les non-équivalences

```text
invocation CCR
    ≠ appel externe confirmé
    ≠ événement de facturation
```

Une sonde de version ou d'état d'authentification est un processus fournisseur, pas
une invocation modèle. La distinction est normative.

## 13.3 L'engagement précède le lancement

```text
décision métier définitive
→ contrôle de politique / quota
→ allocation d'une identité d'invocation
→ écriture durable de l'engagement
→ tentative fournisseur
```

Le vocabulaire retenu nomme un **engagement**, non un lancement, un démarrage de
processus ou une facturation : aucun de ces trois faits n'est atomique avec une
écriture locale.

Après l'engagement, les échecs appartiennent à l'invocation. Avant, aucun refus ne
crée d'invocation.

## 13.4 Engagement, succès, et incertitude

Trois faits distincts, qui ne se confondent pas :

```text
ENGAGEMENT DURABLE   une ressource a été engagée
ÉCHEC RENDU          le dispositif est revenu avec une issue contrôlée
ABSENCE DE RETOUR    personne n'est revenu
```

```text
ENGAGEMENT                ≠  SUCCÈS
INCONNU APRÈS ENGAGEMENT  ≠  ÉCHEC RENDU
```

Un système peut savoir qu'une action a été engagée sans connaître son résultat
terminal. Convertir cette absence de retour en échec affirmerait que rien n'a été
consommé — précisément ce qu'il ignore.

Cette incertitude n'autorise ni rejeu automatique, ni restitution automatique de
budget. La manière de la représenter appartient au contrat applicable ; la doctrine
ne la prescrit pas.

## 13.5 Couverture

Une période antérieure à un instrument de mesure n'affiche pas « zéro ». Elle dit
que la question n'a pas de réponse pour cette période. C'est la même faute que
compter zéro là où l'on n'a pas regardé.

## 13.6 Quota

Un plafond de politique CCR s'attache à la naissance d'un run ; aucune surface ne
permet de l'attacher à un run existant ni de le modifier.

Quota CCR et quota fournisseur ne sont pas synonymes. CCR n'invente jamais une
limite externe : celles-ci restent des observations du fournisseur.

## 13.7 Coût

Une estimation de coût ne se produit que si l'usage, le modèle et le tarif sont tous
disponibles. Aucun joker : le tarif se résout sur le fournisseur exact et le modèle
exact.

L'**observation monétaire rapportée par le fournisseur** est une grandeur distincte
d'une estimation CCR. Elle peut être exposée à côté d'elle ; elle n'en est jamais un
repli silencieux, et les deux ne se présentent jamais comme une même valeur. Ce
n'est ni une facture, ni une autorité monétaire.

Un changement de tarif ne réécrit jamais l'usage historique observé.

## 13.8 Usage orchestré et usage interactif

```text
USAGE ORCHESTRÉ PAR CCR    ce que CCR déclenche
USAGE INTERACTIF HUMAIN    ce que l'humain déclenche en session native
```

CCR mesure exactement le premier. Il n'attribue jamais au premier une consommation
d'origine indéterminée. Lorsque les traces ne séparent pas les deux, l'honnêteté
impose de dire le total observé, la part attribuable et la part non attribuée —
plutôt qu'une exactitude fictive.

## 13.9 Provenance d'usage

Toute mesure porte sa source et son niveau de confiance. Lorsqu'une identité — de
modèle, de provenance, de source — ne peut être établie sans ambiguïté, elle est
enregistrée comme **inconnue avec son motif**, jamais choisie pour faire nombre.

```text
INCONNU  ≠  PROVENANCE INVENTÉE
```

## 13.10 Inconnu et zéro

```text
INCONNU      ≠  ZÉRO
NON OBSERVÉ  ≠  ZÉRO
```

Ne pas avoir observé n'est pas avoir observé zéro. La différence est la distinction
même entre honnêteté et fabrication.

Et lorsqu'un contrat distingue deux observations différentes — n'avoir rien trouvé
d'une part, avoir trouvé quelque chose de vide d'autre part — la doctrine lui
demande de les tenir distinctes. Une absence de trace et une trace d'absence ne sont
pas le même constat.

---

# 14. Présentation

## 14.1 L'invariant

> **Une présentation n'est jamais une autorité métier.**

| Elle peut | Elle ne peut pas |
|---|---|
| reformuler, hiérarchiser, grouper | inventer une capacité |
| filtrer localement | reconstruire une règle métier |
| déplacer, replier, rendre responsive | remplacer un `unknown` par un zéro |
| projeter une lecture additive versionnée | créer un effet fournisseur |
| | inventer un besoin de reprise |
| | réordonner ce dont l'ordre serveur est autoritaire |

Une vue, un cockpit, une interface ou un client ne devient pas l'autorité métier
parce qu'il présente un état.

Une projection de présentation peut être additive et versionnée. Elle est alors
composée depuis le **même** instantané que la lecture autoritaire à laquelle elle
correspond, et ne réécrit aucune valeur qu'elle transporte.

## 14.2 Ordre autoritaire

Un ordre décidé par l'autorité métier ne se reconstruit pas côté présentation.
Trier, regrouper ou dédupliquer une séquence canonique, c'est produire une
affirmation que l'autorité n'a pas faite.

Filtrer localement demeure permis, et ne se confond pas avec réordonner :

```text
FILTRÉ  ≠  RÉORDONNÉ
```

Ce qui est masqué garde sa place ; le révéler le rend là où il était.

## 14.3 Effet d'invocation

Une opération offerte à l'humain déclare son effet fournisseur **avant** d'être
offerte :

```text
EXACT(n)    l'opération produit exactement n invocations
AT_MOST(n)  elle peut en produire jusqu'à n
UNKNOWN     l'effet n'est pas connaissable ici
```

Cet effet n'est jamais codé en dur dans la surface : il provient d'une primitive
partagée avec l'autorité métier.

## 14.4 Sécurité de présentation

```text
AUCUN RENDU DE BALISAGE COMME FRONTIÈRE DE CONFIANCE
```

Le contenu non fiable est analysé par un lexer structuré, converti par un adaptateur
appartenant à CCR, puis construit par nœuds — jamais par concaténation de balisage.
Aucune chaîne interprétable n'existe, donc aucun point d'injection.

Le balisage brut est rendu comme texte. Aucune ressource externe n'est chargée. Un
localisateur reçu d'un tiers est rendu en texte, jamais en lien actif ni en
ressource, tant qu'aucune analyse ne l'a autorisé.

## 14.5 Ce qu'une interface honnête doit refuser

```text
afficher « 0 » là où la question n'a pas de réponse
substituer un montant rapporté à une estimation absente
annoncer qu'un geste est disponible quand aucun ne l'est
```

Chacune est une présentation plausible d'un fait absent. C'est la forme la plus
probable de mensonge dans un outil correct par ailleurs.

Trois refus de même nature s'appliquent aux surfaces de réconciliation :

```text
afficher un classement là où le contrat n'en porte aucun
présenter une option comme principale, recommandée ou préférée
transformer un silence, un délai ou une expiration en acceptation
```

Une surface n'offrant qu'une seule des réponses possibles relève du même interdit :
elle fabriquerait par sa forme une préférence que le contrat refuse d'exprimer.

---

# 15. Intégrité historique

## 15.1 Le principe

Un fait historique déjà établi ne doit pas être silencieusement réécrit pour
correspondre à l'état courant.

Cela vaut pour les documents gelés : on leur succède, on ne les corrige pas pour
qu'ils ressemblent au présent. Cela vaut aussi pour les faits enregistrés d'un run.

## 15.2 Une réponse est un acte nouveau

Une confirmation, une contestation, une correction ou une qualification ultérieure
d'un fait déjà enregistré constitue **un nouvel acte attribué**, qui référence le
fait antérieur — jamais une réécriture de celui-ci.

```text
CONFIRMATION HUMAINE   ≠  VÉRITÉ SUR LE FOND
CONTESTATION HUMAINE   ≠  SUPPRESSION RÉTROACTIVE
```

Une contestation dit qu'une inférence ne doit pas être retenue. Elle ne dit pas que
l'inférence n'a jamais existé, ni que le dispositif ne l'a jamais produite, ni
qu'elle est nécessairement fausse sur le fond.

Ce principe gouverne aussi la réponse humaine à une proposition (§17.3) : c'est un
acte nouveau, enregistré et attribué, et non une modification de la proposition.

## 15.3 Ce que ce principe ne dit pas

Il porte sur les **faits historiques**, non sur l'état opérationnel courant. La
doctrine ne pose pas que tout état CCR serait immuable : un état courant se met à
jour, sous les disciplines du §4.

```text
FAIT HISTORIQUE  ≠  ÉTAT OPÉRATIONNEL COURANT
```

## 15.4 Les écarts se consignent

Lorsqu'une autorité humaine accepte un écart à une règle qu'elle avait posée,
l'acceptation **enregistre** l'écart ; elle ne l'efface pas. Un historique dont on
retire ce qui dérange cesse d'être un historique.

---

# 16. Réconciliation

## 16.1 Quatre capacités et un effet humain conditionnel

```text
LECTURE STRUCTURÉE           lecture dérivée de l'état du désaccord
ACTE HUMAIN DE RÉCONCILIATION  acte humain sur un périmètre explicite
PROPOSITION CCR              attribuée à CCR, sans effet autonome
DÉTECTION STRUCTURELLE       prédicat déterministe sur des faits structurels
EFFET DE CLÔTURE             effet explicite d'un acte humain, borné
```

Cinq notions distinctes, qui ne se confondent jamais : **quatre capacités**, et un
**effet humain conditionnel**. L'effet de clôture n'est pas une capacité autonome —
il n'existe qu'attaché à un acte humain de réconciliation, et disparaît de la
grammaire du dispositif dès qu'on le sépare de lui.

## 16.2 Non-équivalences fondatrices

```text
PROPOSITION      ≠  DÉCISION
DÉTECTION        ≠  REMÉDIATION
VUE DÉRIVÉE      ≠  ACTE HISTORIQUE
CLÔTURE          ≠  VÉRITÉ
CLÔTURE          ≠  CONVERGENCE
CLÔTURE          ≠  ACCORD DES EXPERTS
```

## 16.3 Ce que la réconciliation n'établit jamais

```text
la vérité d'un énoncé      un gagnant        une preuve préférée
la fiabilité d'un élément  un classement     une probabilité de vérité
la suffisance probatoire   un poids          une convergence
```

## 16.4 Persisté et dérivé

Ce qui est **persisté** est un fait enregistré, attribué et daté. Ce qui est
**dérivé** est une lecture de l'instantané, recalculable et jamais figée.

Une détection n'est pas persistée : la figer créerait un fait périssable qu'un
lecteur prendrait pour un constat tenu par CCR.

## 16.5 Aucun arbitrage automatique

```text
NO LLM JUDGE
```

Aucune sortie de modèle, aucune détection, aucune couverture structurelle ne
produit d'effet par elle-même.

---

# 17. Proposition, réponse, acte humain

## 17.1 La proposition

Une proposition CCR établit **qu'elle a été produite et enregistrée**, dans ce
contexte, à partir de ces entrées. Elle n'établit ni qu'elle soit correcte, ni
qu'elle doive être suivie.

```text
PROPOSITION  ≠  DÉCISION
SORTIE DE MODÈLE  ≠  AUTORITÉ HUMAINE
```

## 17.2 Options, sans classement

```text
ORDRE  ≠  PRÉFÉRENCE
UNIQUE ≠  GAGNANT
```

Aucun score, aucun poids, aucune recommandation, aucune option « principale ». Une
proposition à une seule option reste non contraignante.

## 17.3 Réponse humaine — ce qu'elle est

Une réponse à une proposition **est un acte humain**, enregistré et attribué. Ce
n'est pas un événement machine, et ce n'est pas rien.

Ce qu'elle n'est pas, c'est un acte **autoritaire** :

```text
RÉPONSE ENREGISTRÉE  =  acte humain
RÉPONSE ENREGISTRÉE  =  AUCUN effet autoritaire

RÉPONSE « ACCEPTER »  ≠  ACTE AUTORITAIRE DE RÉCONCILIATION
ACCEPTER              ≠  FAIRE SIEN
```

Une réponse ne produit ni clôture, ni retrait de clôture, ni supersession.

**Conséquence de forme.** Une réponse ne porte aucun périmètre : elle ne gouverne
aucune unité, et un périmètre n'y servirait qu'à se faire lire comme le périmètre
d'un effet.

## 17.4 Les deux références d'option

```text
RÉFÉRENCE D'OPTION DE RÉPONSE   l'option SUR LAQUELLE porte une réponse humaine
                                aucun effet — ni adoption, ni autorité

RÉFÉRENCE D'OPTION ADOPTÉE      l'option dont un humain fait sien le contenu
                                accompagne toujours un contenu humain
```

```text
RÉFÉRENCE D'OPTION DE RÉPONSE  ≠  RÉFÉRENCE D'OPTION ADOPTÉE
RÉFÉRENCE D'OPTION DE RÉPONSE  ≠  ADOPTION HUMAINE AUTORITAIRE
```

Deux sémantiques distinctes, donc deux noms distincts. Les unifier créerait
exactement la confusion que la distinction existe pour empêcher.

## 17.5 Produire un effet à la suite d'une proposition

Pour qu'un effet existe, l'humain enregistre un acte complet, portant son **propre
contenu attribué**, sa cible, son périmètre déclaré, sa provenance, et ses effets
explicites.

Trois relations possibles à une proposition, sémantiquement distinctes :

```text
FAIRE SIEN     l'humain reprend le contenu proposé, par déclaration explicite,
               et désigne sans ambiguïté l'option adoptée
MODIFIER       la proposition demeure la base explicite d'un contenu humain modifié
REMPLACER      le contenu humain est indépendant ; la proposition demeure contexte
```

Dans les trois cas, le contenu de décision est **présent et humain**.

## 17.6 Interdits de surface

```text
INTERDIT  n'offrir que l'acceptation
INTERDIT  acceptation par défaut
INTERDIT  acceptation par expiration de délai
INTERDIT  acceptation par silence
```

Une surface d'acte humain existe **indépendamment de toute proposition** : la
possibilité d'agir ne naît pas de l'existence d'une suggestion.

## 17.7 `VALID_ZERO`

Une production peut être valide et vide.

```text
VALID_ZERO  =  sortie structurellement valide contenant zéro proposition
```

```text
VALID_ZERO  ≠  consensus              ≠  accord
VALID_ZERO  ≠  échec                  ≠  vérité
VALID_ZERO  ≠  décision
VALID_ZERO  ≠  preuve que le contexte était suffisant
```

Il dit ce qu'il a toujours dit : la sortie était valide, et vide. Il ne certifiera
jamais que le modèle avait de quoi juger.

---

# 18. Clôture

## 18.1 Ce qu'une clôture est

```text
CLÔTURE  =  effet humain explicite
         +  autorité suffisante
         +  périmètre explicite
```

Ce n'est pas un acte séparé : c'est un **champ d'effet porté par un acte humain**.
Absent, il n'y a aucun effet de clôture — aucune valeur implicite.

## 18.2 Portée

L'effet porte **exactement** sur les unités énumérées du périmètre.

```text
CLÔTURE HORS PÉRIMÈTRE  =  NON
```

Une clôture partielle et une clôture de périmètre entier sont deux faits distincts,
et l'une ne se lit jamais comme l'autre.

## 18.3 Ce qui ne produit jamais de clôture

```text
une proposition        une détection         une sortie de modèle
une absence de signal  un silence            un retrait de position
l'inactivité           une couverture structurelle complète
une réponse « accepter » seule
la supersession d'un autre acte
```

## 18.4 Ce qu'une clôture n'établit pas

```text
CLÔTURE  ≠  VÉRITÉ
CLÔTURE  ≠  CONVERGENCE
CLÔTURE  ≠  ACCORD DES EXPERTS
CLÔTURE  ≠  effacement du désaccord historique
```

Une controverse close peut conserver un désaccord expert entier.

## 18.5 Aucune clôture automatique

```text
CLÔTURE AUTOMATIQUE  =  NON
```

---

# 19. Supersession et actualités

## 19.1 Deux actualités indépendantes

```text
ACTUALITÉ DE DÉCISION          quels actes humains sont courants comme décisions
ACTUALITÉ D'EFFET DE CLÔTURE   quels effets de clôture sont courants, par unité
```

```text
ACTUALITÉ DE DÉCISION  ≠  ACTUALITÉ D'EFFET DE CLÔTURE
```

Aucune des deux ne se déduit de l'autre. Aucun objet ne les réunit sous un même
champ.

## 19.2 Superséder une décision ne retire pas un effet

```text
SUPERSESSION D'UNE DÉCISION  ≠  SUPERSESSION D'UN EFFET DE CLÔTURE
```

Une clôture validement déclarée continue de produire son effet sur son périmètre
explicite **jusqu'à ce qu'un acte humain explicite modifie cet effet**.

## 19.3 Le retrait de clôture est explicite

Une réouverture exige cumulativement une origine humaine, une autorité suffisante,
une cible canonique, un périmètre explicite, et une déclaration explicite de
modification de l'effet.

## 19.4 Ce qui ne rouvre jamais

```text
la supersession seule      la récence            la contradiction
une décision nouvelle      une proposition CCR   une détection
une sortie de modèle       le silence
```

```text
RÉCENCE        ≠  SUPERSESSION
CONTRADICTION  ≠  SUPERSESSION
```

## 19.5 Superséder n'efface pas

Un acte supersédé demeure enregistré. La supersession ordonne l'actualité ; elle ne
réécrit pas l'histoire.

---

# 20. Vue dérivée du désaccord

## 20.1 Ce qui existe, et ce qui n'existe pas

```text
VUE DÉRIVÉE DU DÉSACCORD            =  OUI
ÉTAT CANONIQUE POSITIF DE DÉSACCORD =  NON
```

CCR rend visibles des **signaux explicites de désaccord**, chacun avec son
identité, son attribution et son ancrage. Il ne tient aucun état « en désaccord ».

## 20.2 Les interdits

```text
INTERDIT  absence de clôture       ⇒  désaccord persistant
INTERDIT  retrait de clôture       ⇒  désaccord persistant
INTERDIT  absence de signal        ⇒  accord
INTERDIT  compte de signaux        ⇒  intensité
INTERDIT  score de désaccord       ·  état positif canonique
```

## 20.3 Ce que la vue n'est pas

```text
VUE DU DÉSACCORD  ≠  ÉCHEC
VUE DU DÉSACCORD  ≠  CONVERGENCE NÉGATIVE
VUE DU DÉSACCORD  ≠  CLÔTURE
```

---

# 21. `CONVERGED`

```text
CONVERGED  =  RÉSERVÉ
```

La doctrine ne le définit pas, ne l'emploie pas comme état, ne le déduit d'aucune
clôture ni d'aucun retrait, et n'en déduit rien.

```text
CLOS                ≠  CONVERGÉ
RETRAIT DE CLÔTURE  ≠  CONVERGENCE NÉGATIVE
```

La question — *que démontrerait une convergence, si l'on voulait un jour la
nommer ?* — **reste ouverte**. La doctrine ne la tranche pas ; elle rend
impossible de la trancher par accident.

---

# 22. Contexte explicite d'une proposition assistée

*Règle de périmètre. Elle vaut pour la proposition assistée de réconciliation, et
pour elle seule.*

## 22.1 La politique

```text
POLITIQUE DE CONTEXTE DE PROPOSITION  =  CONTEXTE CANONIQUE EXPLICITE
```

Une proposition assistée ne peut pas être demandée à partir d'identifiants opaques
seuls. Le modèle reçoit un contexte sémantique **explicite, canonique, borné et
auditable**, restreint au périmètre soumis.

## 22.2 Ce que cette politique ne déplace pas

```text
DONNER À LIRE  ≠  DONNER AUTORITÉ
CONTEXTE       ≠  MANDAT
```

L'absence de juge automatique demeure intégralement.

## 22.3 Session fraîche — règle de périmètre

```text
POLITIQUE DE SESSION POUR LA PROPOSITION  =  SESSION FRAÎCHE
```

Le chemin assisté n'emprunte pas la session native d'un expert.

**Motif normatif.** La continuité cognitive implicite d'une session experte ne doit
pas remplacer un contexte épistémique explicite et auditable. Ce qu'un modèle « se
rappelle » n'est ni énumérable, ni bornable, ni vérifiable, ni reproductible ; ce
que CCR transmet l'est.

```text
SESSION NATIVE        ≠  AUTORITÉ DE CONTEXTE
CONTINUITÉ COGNITIVE  ≠  CONTINUITÉ ÉPISTÉMIQUE
```

## 22.4 Ce que cette règle ne dit pas

Cette politique est **scopée**. Elle n'est pas étendue par ce document à toutes les
inférences assistées présentes ou futures.

```text
GÉNÉRALISATION DE LA SESSION FRAÎCHE  =  DÉCISION HUMAINE OUVERTE
```

Toute extension devrait être décidée explicitement, et non héritée par ressemblance.

---

# 23. Dispositions et différés

Un point différé porte toujours une disposition explicite.

```text
DIFFÉRÉ  ≠  OUBLIÉ
DIFFÉRÉ  ≠  ACQUIS
```

« Plus tard » n'est pas un statut. Une propriété différée reste contractuelle : elle
n'est ni abandonnée, ni comptée comme prouvée.

---

# 24. Capacités courantes

CCR sait aujourd'hui :

```text
tenir des sessions natives persistantes, une par rôle d'expert
transférer une réponse d'un expert à l'autre, verbatim
accepter l'intervention humaine à tout instant
ouvrir une session interactive native vers un expert
représenter une controverse, ancrée dans les échanges qui l'ont produite
retenir des matériaux, et enregistrer qu'on les a versés au débat
proposer une réconciliation, sans effet propre
enregistrer une réponse humaine, et un acte humain de réconciliation
compter ce qu'il déclenche, et refuser de dépasser la limite posée
persister l'historique, et reprendre après interruption sans rien inventer
```

Chacune de ces capacités est bornée par les sections qui précèdent. Ce que CCR
sait faire a augmenté ; ce qu'il s'autorise à affirmer, non.

---

# 25. Frontière courante

```text
AUCUNE FRONTIÈRE PRODUIT N'EST OUVERTE
```

L'ouverture d'un nouveau chantier relève d'une décision humaine explicite. Aucune
n'est réservée, aucune n'est promise.

---

# 26. Question de recherche parallèle — délégation cognitive

Une question demeure ouverte, sans périmètre, sans acceptation et sans
engagement : l'**ingénierie de délégation cognitive**.

```text
définition d'une mission           définition d'un stream
construction du contexte transmis  propriété (ownership)
périmètre et son évolution         transitions et passages de témoin
interruptions · reprise            contamination de rôle
duplication · dérive               contrôle de la consommation
```

S'y ajoute la question du **handoff interactif** : propriété d'une session
interactive, terminal, durée, verrous, et provenance des messages échangés hors
du chemin orchestré.

Une contrainte est connue d'avance : une telle orchestration devrait **consommer**
les primitives de gouvernance existantes, jamais les contourner.

Ce n'est pas une feuille de route. C'est une question.

---

# 27. Invariants à préserver dans tout travail futur

**1. L'autorité normative humaine est finale.**
CCR peut refuser, compter, structurer et exposer ; il ne décide pas ce qui doit
être. Une autorité humaine ne vaut que pour le périmètre exact qu'elle arbitre.

**2. Rôle d'expert ≠ fournisseur.**

**3. Continuité native ≠ continuité épistémique persistée.**

**4. L'attribution est multi-dimensionnelle.**

**5. Attribution ≠ approbation.**

**6. Auditable ≠ produit par la source.**

**7. Une inférence ne porte que sur ce qui a été observé.**

**8. Le silence ne clôt rien.**
Ni le silence, ni l'inactivité, ni un retrait, ni un accord inféré. Le maintien
d'un désaccord est légitime, et `CONVERGED` reste réservé.

**9. Retenir ≠ verser au débat.**

**10. Soutien ≠ vrai ; objection ≠ faux ; absence d'orientation ≠ non-pertinence.**

**11. Validation déterministe ≠ validation du fond.**

**12. Assisté par modèle ≠ vérité du modèle.**

**13. Finding ≠ remediation.**

**14. La présentation n'est pas une autorité métier.**
Elle ne reconstruit aucun ordre autoritaire, et filtrer n'est jamais réordonner.

**15. Invocation ≠ appel externe confirmé ≠ événement de facturation.**

**16. Engagement ≠ succès ; inconnu après engagement ≠ échec rendu.**

**17. Unknown ≠ zero.**

**18. Une période sans instrument de mesure ≠ absence d'activité.**

**19. Montant rapporté par un fournisseur ≠ estimation CCR.**

**20. Les classes de preuve ne se confondent jamais.**

**21. Pas d'autonomie avant le compteur et le frein.**

**22. Les faits historiques ne sont pas réécrits rétroactivement.**
Une réponse ultérieure est un fait nouveau ; un acte supersédé reste enregistré.

**23. Un élément différé porte toujours une disposition explicite.**

**24. Proposition ≠ décision.**
Une production attribuée à CCR n'a aucun effet par elle-même, ne se classe pas, ne
recommande pas, et ne désigne aucun gagnant.

**25. Une réponse humaine est un acte, sans effet autoritaire.**
Elle est enregistrée et attribuée ; elle ne clôt rien, ne supersède rien, et
accepter n'est pas faire sien.

**26. Clôture ≠ vérité ≠ convergence ≠ accord des experts.**
Une clôture est un effet humain explicite, borné à son périmètre énuméré, et jamais
automatique.

**27. Actualité de décision ≠ actualité d'effet de clôture.**
Superséder une décision ne retire aucun effet ; une réouverture est explicite. Ni
la récence ni la contradiction ne supersèdent.

**28. Vue dérivée du désaccord, jamais état positif de désaccord.**
Absence de clôture n'est pas désaccord persistant ; absence de signal n'est pas
accord.

**29. Contexte ≠ mandat.**
Donner à lire n'est pas donner autorité, et une politique de contexte scopée ne
s'étend pas par ressemblance.

---

# 28. Questions explicitement ouvertes

Ces énoncés sont des **questions de recherche**, sans périmètre, sans acceptation et
sans version.

## Sur la controverse et sa suite

```text
comment distinguer un désaccord persistant d'un désaccord simplement répété ?
que démontrerait une convergence, si l'on voulait un jour la nommer ?
```

## Sur la réconciliation

```text
qu'est-ce qui, dans une réconciliation enregistrée, mériterait d'être mesuré —
    et une mesure ajouterait-elle autre chose qu'un classement déguisé ?
une détection structurelle devrait-elle un jour être persistée, et à quel prix ?
```

## Sur l'assistance

```text
la politique de session fraîche doit-elle s'étendre au-delà de la proposition
    de réconciliation, et sur quel fondement ?
quel contexte explicite serait requis pour une inférence assistée d'une autre
    nature que la proposition ?
```

## Sur la délégation

```text
comment se définit la propriété d'une mission ou d'un stream ?
comment une interaction humaine distante est-elle possédée, et par quel processus ?
comment détecter une contamination de rôle avant qu'elle ne produise
    une fausse indépendance ?
```

## Sur la mesure

```text
jusqu'où l'attribution d'usage peut-elle rester honnête quand les traces
    ne séparent pas orchestré et interactif ?
quel provisioning tarifaire réel serait acceptable sans transformer CCR
    en outil de facturation ?
```

---

# 29. Conclusion

Le dispositif sait transporter, observer, distinguer, compter, présenter,
structurer, étayer et réconcilier.

```text
transporter    établir la continuité entre des conversations distinctes
observer       rendre l'état lisible sans le déformer
distinguer     séparer le rôle du moteur
compter        mesurer sans arrondir
présenter      dire sans inventer
structurer     porter un désaccord sans le juger
étayer         retenir et verser, sans conclure
réconcilier    proposer sans décider, clore sans prétendre au vrai
```

Ce que CCR sait faire a augmenté à chaque étape. Ce qu'il s'autorise à affirmer,
non. La réconciliation était l'endroit où cette discipline était la plus facile à
perdre : un dispositif qui organise la réconciliation est à un pas de désigner un
gagnant. Il ne le fait pas — non parce que la fonctionnalité manque, mais parce
que chaque endroit où elle aurait pu apparaître porte un interdit nommé.

Le maintien d'un désaccord reste un résultat légitime. `CONVERGED` reste réservé.
L'autorité normative humaine reste finale.
