# CCR Design Foundations

**CCR — Contradictory Cross-Review / Contre-expertise croisée**

Ce document expose les principes de conception dont CCR part : douze distinctions
que le projet maintient explicites, les raisons d'être de chacune, et ce que
chacune se refuse délibérément à affirmer.

C'est l'exposé d'une discipline de conception. Ce n'est ni de la doctrine, ni une
spécification — la section finale précise en quoi les trois registres diffèrent.

---

# Pourquoi ces fondations comptent

CCR existe à cause d'un mode de défaillance précis, plus précis que « les modèles
se trompent ».

Une représentation erronée n'est pas nécessairement corrigée par le travail qui
lui succède. Elle peut être élaborée. Chaque étape suivante est localement
raisonnable, se réfère à la précédente et ajoute de la solidité apparente — sans
ajouter la moindre correspondance au réel. Le résultat est cohérent de
l'intérieur, défendable en chaque point, et faux au niveau du cadre. Rien en aval
ne le rattrape, parce que tout ce qui est en aval est cohérent avec elle.

Organiser la confrontation entre des relecteurs distincts est une réponse
plausible à ce problème, et c'est de là que part CCR. Mais organiser la
confrontation est en soi un acte d'ingénierie, et cela introduit un risque de
second ordre facile à manquer : **l'orchestrateur accumule une autorité que
personne ne lui a accordée.**

C'est ce risque qui donne leur forme à ces fondations. Chaque fois que CCR prend
en charge une part supplémentaire du processus — persister un état, exécuter des
experts, représenter un désaccord, détenir des matériaux probatoires, enregistrer
des issues, assembler le contexte d'un modèle assisté — il gagne une occasion
nouvelle de dire quelque chose d'un peu plus fort que ce qu'il sait réellement.
Non pas en inventant un fait primitif, mais en laissant une structure légitime
porter un sens que personne n'a établi.

Les fondations ci-dessous sont les frontières que CCR maintient explicites en
réponse.

Deux propriétés de l'ensemble méritent d'être posées d'emblée, car elles changent
la manière de le lire.

**Ce n'est pas un programme de minimisation.** Aucune de ces fondations ne dit
que CCR devrait en faire moins. La plupart existent précisément parce que CCR en
fait davantage : plus d'état, plus de structure, plus de dérivation, plus de
surfaces. La discipline ne consiste pas à restreindre les capacités. Elle
consiste à préciser ce que chacune est autorisée à signifier.

**Ce n'est pas une théorie exhaustive.** Douze fondations : c'est ce dont le
projet part aujourd'hui. C'est un ensemble de travail, révisable à mesure que la
conception rencontre de nouveaux éléments. Rien ici ne prétend que
l'orchestration fiable se réduit à douze principes.

---

# Les douze fondations

Chaque fondation est écrite pour tenir seule. Les interactions les plus porteuses
sont rassemblées ensuite.

---

## F1 — `AGREEMENT ≠ EVIDENCE`

L'intuition qui rend les systèmes multi-relecteurs attirants est aussi leur
premier piège. Si un modèle peut se tromper, en interroger deux. Si les deux
disent la même chose, cela doit bien compter pour quelque chose.

Cela compte pour quelque chose. Ce que cela ne fait pas, c'est établir un fait.

CCR sépare l'accord et le nombre de modèles de la preuve factuelle, et attribue
l'autorité factuelle à ce qui établit réellement l'énoncé — preuve, code,
comportement observable. La concordance entre relecteurs ne s'y substitue pas.
Deux relecteurs peuvent partager une distribution d'entraînement, un cadrage, un
angle mort, ou simplement la même lecture d'un artefact ambigu. Leur accord est
compatible avec le fait que les deux se trompent, et compatible avec le fait que
le second ait été influencé par le premier. Les compter ne résout aucune de ces
deux possibilités.

L'enjeu est architectural plutôt que rhétorique. Traiter la concordance comme une
preuve fait d'une valeur de convergence calculée une possibilité architecturale
tentante — au même titre que des statuts déclarant un désaccord résolu. Ce sont
des tentations de conception que CCR décline, et `CONVERGED` appartient à la même
famille : CCR ne traite pas de telles sémantiques de convergence comme faisant
autorité.

Le problème de telles valeurs n'a jamais été qu'elles soient difficiles à
calculer. C'est que les calculer fabriquerait une autorité que personne ne
détient.

La conséquence porte loin : il n'existe aucun état agrégé disant qu'un désaccord
a été tranché par les experts. L'accord est représentable pour ce qu'il est — un
fait sur ce que les relecteurs ont dit — jamais comme une conclusion sur ce qui
est vrai.

**Ce que cela ne signifie pas.** L'accord n'est pas sans valeur. Il peut porter
une valeur informationnelle et épistémique réelle : orienter l'attention, élever
ou abaisser une priorité, indiquer qu'une question n'est probablement pas la
question intéressante. La pluralité est utile comme résistance critique — une
manière de rendre une position faible plus difficile à tenir — plutôt que comme
mécanisme de vote. `EVIDENCE` a par ailleurs ici un sens précis : la preuve
factuelle suffisante pour établir ou contraindre un énoncé factuel. Ce n'est pas
un synonyme de tout matériau que CCR se trouve détenir.

---

## F2 — `CLAIM NATURE BOUNDS ITS LEGITIMATE BASIS`

Le second piège est plus subtil, et il survit même lorsque toutes les personnes
impliquées sont compétentes et honnêtes.

Une source peut être parfaitement légitime dans son propre domaine et rester la
mauvaise sorte d'autorité pour la question posée. Un banc d'essai tranche une
question de performance et ne tranche rien sur l'opportunité d'une
fonctionnalité. Une spécification tranche ce qui était voulu et ne tranche pas ce
que fait le code. Une lecture experte tranche la manière dont un passage peut
être compris et ne tranche pas ce que son auteur voulait dire. Dans chaque cas,
la source est bonne. La discordance est entre ce que la source peut établir et la
nature de la proposition.

CCR distingue les questions factuelles, interprétatives et normatives, et les
traite comme exigeant des bases structurellement différentes. Un énoncé factuel
demande un établissement factuel. Un énoncé interprétatif demande une
reconstitution du cadre et de la source, une analyse attribuée, et — là où une
intention non résolue doit être tranchée plutôt que décrite — une intervention
humaine. Un énoncé normatif demande une autorité de décision humaine, et rien ne
s'y substitue.

Cette fondation aide à expliquer pourquoi CCR ne fonctionne pas comme un moteur
d'arbitrage. Un système qui classerait les positions par la seule qualité de leur
source tranchera avec assurance des désaccords normatifs au moyen de preuves
factuelles, et des désaccords interprétatifs au moyen de la lecture la mieux
citée. Ce sont deux erreurs de catégorie qui ont l'allure de la rigueur.

La conséquence de conception est un renoncement auquel CCR est parvenu. Une
tentation de conception antérieure exigeait que les désaccords soient classés
d'emblée, sur l'hypothèse raisonnable que connaître la nature de la question
était un préalable à son traitement. Cette classification obligatoire a été
écartée. Qualifier la nature d'une controverse est **facultatif**, **attribué** à
qui l'a qualifiée, peut simplement rester inconnu, et n'emporte aucune
conséquence automatique lorsqu'il est présent.

**Ce que cela ne signifie pas.** Il n'existe aucune taxonomie ternaire
obligatoire et exhaustive dans laquelle chaque désaccord devrait entrer. Les
trois natures sont une distinction analytique, non un schéma imposé, et CCR
refuse délibérément d'énumérer une liste fermée. Il n'existe pas davantage
d'« autorité interprétative » finale — aucun rôle ni mécanisme habilité à
déclarer ce qu'un passage voulait réellement dire. Là où l'interprétation
s'épuise, l'escalade va vers la décision humaine, non vers un meilleur
interprète.

---

## F3 — `COGNITIVE CONTINUITY ≠ EPISTEMIC CONTINUITY`

Faire travailler deux experts sur de nombreux tours soulève une question qui a
l'air d'une question de plomberie et n'en est pas une : que doivent-ils retenir,
et qui le détient ?

Les deux conceptions évidentes sont structurellement insatisfaisantes. Donnez aux
experts une conversation partagée, et les continuités conversationnelles
distinctes s'effondrent en une seule. Ne leur donnez aucune continuité, et chaque
tour repart de zéro, ce qui n'est pas de la relecture mais des premières
impressions répétées.

CCR sépare deux formes de continuité qui, autrement, se confondent. La session
native de chaque expert auprès de son fournisseur porte la **continuité
cognitive** — le fil du raisonnement, le cadrage accumulé, ce que cette session
soutient. L'état canonique persisté par CCR porte la **continuité épistémique** —
le relevé attribuable et auditable de ce qui a effectivement été dit, transmis,
décidé et enregistré.

Les deux sont distinctes, complémentaires, et non substituables dans un sens
comme dans l'autre. CCR ne reconstitue pas ce qu'un expert pensait à partir de sa
transcription, et il ne verse pas son relevé canonique dans les conversations des
experts comme si c'était la même chose. Deux tentations de conception se tiennent
de part et d'autre de cette ligne : un humain acheminant le contenu entre les
experts en guise de couche de transport, et la dérivation de l'état de CCR depuis
ce que contiennent les sessions fournisseur. Chacune effondrerait les deux
continuités dans une direction différente.

Le résultat est une mémoire de processus commune sans mémoire conversationnelle
commune : chaque expert garde sa propre continuité, et l'état partagé vit en
dehors des deux conversations.

**Ce que cela ne signifie pas.** Des sessions distinctes ne sont **pas** une
indépendance statistique démontrée. Deux sessions séparées peuvent partager un
fournisseur, une famille de modèles, une forme de prompt et bien davantage ; CCR
les sépare structurellement et n'affirme rien de leur relation statistique. La
continuité cognitive n'est pas une mémoire parfaite — c'est ce que la session
fournisseur soutient réellement. La continuité épistémique n'est catégoriquement
pas la vérité : un relevé attribuable et auditable de ce qui a été dit n'est pas
un relevé de ce qui est. Et une session fraîche n'est pas une politique
universelle de CCR ; là où CCR en exige une, c'est borné à un chemin précis, et
`F10` dit lequel.

---

## F4 — `OBSERVATION BOUNDS CLAIMS`

Les systèmes qui touchent au monde extérieur sont en permanence à un petit pas de
dire plus qu'ils n'ont vu.

Une sonde expire. Un journal n'a aucune entrée pour une période antérieure à son
existence. Un sous-processus est tué et ne rapporte rien. Un champ est absent.
Dans chaque cas, le système détient quelque chose de moindre qu'une observation,
et dans chaque cas un geste local est tentant : combler. L'expiration devient un
échec. Le journal manquant devient zéro. L'absence de trace devient « rien ne
s'est produit ». Non vérifié devient faux.

Chacun de ces gestes est une petite fabrication, et chacun produit un état
indiscernable, en aval, d'un état réellement observé.

CCR tient la ligne explicitement. `UNKNOWN` est conservé plutôt que résolu.
L'observation manquante reste distincte d'un état positif. L'inférence est
contrainte aux entrées réellement observées. Les distinctions forment une
famille :

```text
OBSERVATION MANQUANTE  ≠  ÉTAT POSITIF
NON-OBSERVATION        ≠  ABSENCE OBSERVÉE
UNKNOWN                ≠  ZÉRO
TRACE ABSENTE          ≠  TRACE D'UNE ABSENCE
AUCUN RETOUR           ≠  ÉCHEC RETOURNÉ
NON VÉRIFIÉ            ≠  FAUX
```

Le coût est réel et CCR le paie : un système qui refuse de combler ses propres
lacunes doit exposer son incomplétude à ses utilisateurs, ce qui est moins
confortable que d'afficher un chiffre net. La conception accepte un état
explicitement incomplet plutôt qu'un état complet fabriqué sans base suffisante.

Trois endroits concrets montrent cette pression : la non-capture délibérée du
contexte Git, la période antérieure à l'existence du journal d'invocations, et
les issues de sonde réellement ambiguës. Dans chacun, la représentation honnête
est celle qui dit que CCR ne sait pas.

**Ce que cela ne signifie pas.** Ce n'est pas une interdiction d'inférer.
L'inférence qualifiée reste pleinement légitime lorsque sa base et son statut
sont explicites — lorsque le lecteur peut voir qu'il s'agit d'une dérivation, sur
quoi, et par qui. `F4` ne dit pas que CCR n'infère jamais. Il dit qu'une
inférence ne doit pas pouvoir se présenter comme une observation.

---

## F5A — `PROTOCOL ROLE, EXECUTOR, AND NATIVE SESSION ARE DISTINCT DIMENSIONS`

Une manière intuitive de parler d'un run de relecture passe par le nom du
fournisseur : la CLI d'un fournisseur est l'auteur, celle d'un autre est le
challenger. C'est concret et tout le monde le comprend — et cela contraint des
choses qui n'ont rien à voir avec les fournisseurs.

Nommer les rôles d'après les moteurs fait apparaître trois dimensions différentes
comme une seule :

```text
QUI AGIT                    le rôle de protocole
AVEC QUEL MOTEUR            l'affectation d'exécutant
DANS QUELLE SESSION NATIVE  le fil conversationnel
```

CCR les sépare structurellement. `ExpertSlot` est le rôle de protocole — auteur,
challenger — et le rôle *est* l'identité. `ProviderBinding` est l'affectation
technique d'un moteur à un slot. `NativeSession` est la continuité
conversationnelle que ce slot entretient. Un run peut lier les deux slots au
**même fournisseur** tout en gardant les slots d'expert et leurs sessions natives
distincts.

Cette dernière configuration est le cas éclairant. Sous le régime
fournisseur-comme-identité, elle est quasi irreprésentable : si l'auteur *est* un
fournisseur et le challenger *est* un autre, deux auteurs de la même marque sont
une
contradiction plutôt qu'une configuration. Sous le modèle séparé, elle n'a rien
de remarquable — deux rôles, un type de moteur, deux sessions.

Le point de fond est que l'identité intellectuelle d'un rôle de relecture
appartient au protocole, non à la marque du moteur qui l'exécute. Le fournisseur
exécute l'expert ; il ne définit pas l'expert.

**Ce que cela ne signifie pas.** La diversité de fournisseurs n'est **pas** une
exigence de protocole. CCR l'autorise et ne l'impose pas. Plus précisément :
savoir si employer des fournisseurs différents améliore réellement la qualité de
la relecture n'est **pas établi** — c'est une question empirique ouverte, non une
justification de conception. `F5A` est un énoncé d'hygiène représentationnelle,
non un énoncé sur les bénéfices épistémiques d'un mélange de fournisseurs.

---

## F5B — `RESOURCE COMMITMENT, OBSERVATION, ESTIMATE, AND POLICY MUST REMAIN DISTINCT`

Un second type de confusion devient aigu dès l'instant où un orchestrateur se met
à dépenser les ressources de quelqu'un.

Quatre choses se tiennent proches et sont constamment confondues :

```text
ENGAGEMENT   ce que CCR s'est durablement engagé à faire
OBSERVATION  ce que CCR a réellement observé de ce qui s'est passé
ESTIMATION   ce que CCR a calculé comme grandeur dérivée
POLITIQUE    ce que CCR était autorisé à engager au départ
```

Elles ont des conditions de vérité différentes. Un engagement est exact — CCR l'a
écrit, CCR le sait. Une observation dépend de ce que le fournisseur a rapporté,
qui peut être partiel ou absent. Une estimation dépend d'un modèle de tarification
qui peut être périmé ou approximatif. Une politique est la règle d'admission
propre à CCR, qui n'est pas le quota du fournisseur.

CCR les représente séparément plutôt que de les réconcilier en un seul chiffre.
Trois confusions sont déclinées par conception : traiter une invocation comme
équivalente à un appel fournisseur, forcer les totaux de jetons en une grandeur
normalisée unique, et afficher une valeur monétaire fournie par le fournisseur
comme s'il s'agissait de l'estimation propre à CCR.

La règle qui s'en dégage mérite d'être dite sans détour : CCR rend exact ce qu'il
contrôle, et qualifié ce qu'il ne peut qu'observer ou estimer. Il n'élève pas le
second au niveau du premier par commodité de présentation.

Un principe de séquencement l'accompagne, et il gouverne jusqu'où CCR consent à
agir de lui-même : on ne construit pas l'autonomie avant que le compteur et le
frein existent. Une capacité en mesure de dépenser des ressources ne devrait pas
précéder la comptabilité et les contrôles d'admission qui la bornent.

**Ce que cela ne signifie pas.** Chacune de ces relations est une
non-équivalence distincte, et aucune n'affirme que les grandeurs seraient sans
rapport :

```text
INVOCATION              ≠  exécution fournisseur confirmée
OBSERVATION D'USAGE     ≠  usage complet
ESTIMATION DE COÛT      ≠  facture
BUDGET CCR              ≠  quota du fournisseur
```

Une invocation engagée dit que CCR s'est engagé ; elle ne dit pas que le
fournisseur a exécuté. Une grandeur d'usage observée dit ce qui a été rapporté ;
elle ne dit pas que c'est tout ce qui a été consommé. Une estimation est une
dérivation, pas une facture. Et le budget propre à CCR est une politique
d'admission interne, sans autorité sur celui du fournisseur ni connaissance de
celui-ci.

---

## F6 — `PRESENTATION ≠ BUSINESS AUTHORITY`

Une distinction peut être correctement représentée dans le cœur et détruite en
chemin vers un écran.

`F6` nomme deux classes de défaillance, toutes deux faciles à sous-estimer. Une
surface peut falsifier la sémantique alors même que les faits qu'elle reçoit sont
corrects ; elle peut aussi fabriquer une complétude apparente en comblant une
valeur que le cœur a délibérément laissée inconnue.

Première classe : l'interface affiche une valeur présente dans l'état canonique,
la valeur est correcte, et l'interface lui donne un sens que le système n'a
jamais établi. Un montant fourni par le fournisseur apparaît là où une estimation
a sa place. Une affordance de reprise apparaît là où aucun geste de reprise
n'existe. Un client trie des enregistrements dans un ordre que le serveur n'a
jamais affirmé.

Seconde classe : un journal absent est rendu comme un zéro — une lacune que le
cœur a laissée ouverte, refermée par la surface.

Chacun de ces cas est un énoncé de sémantique métier produit par une surface.

La réponse de CCR définit le cockpit comme une **surface au-dessus** de CCR, non
comme un second moteur CCR. La projection de présentation est additive : elle
peut dériver, agencer et expliquer, et elle ne peut pas redéfinir l'état faisant
autorité. La généralisation est plus large que le cockpit : les surfaces et les
transports acheminent des actes métier sans devenir des autorités métier.

**Ce que cela ne signifie pas.** C'est la frontière la plus exposée au risque de
sur-lecture, aussi la précision importe-t-elle. Une présentation riche est
légitime. Le sens présentationnel est légitime. Une surface peut organiser,
expliquer, contextualiser, regrouper, mettre en avant et projeter des faits
faisant autorité — c'est à cela que sert une surface, et bien le faire est une
vertu de conception plutôt qu'un risque de non-conformité. La hiérarchie visuelle
n'est pas intrinsèquement une autorité métier : mettre en avant n'est pas
affirmer. Le frontend n'a **pas** à être un rendu passif.

Ce qu'une surface ne peut pas faire, c'est créer, altérer ou compléter une
sémantique métier faisant autorité — inventer un état, changer le sens d'une
valeur, ou combler une lacune que le cœur a délibérément laissée ouverte.

---

## F7 — `SEMANTIC STRUCTURE MUST PRESERVE ATTRIBUTION`

Les fondations précédentes portent sur ce que CCR dit. Celle-ci porte sur ce que
le **schéma** de CCR dit en son nom.

Un modèle de données n'est pas un contenant neutre. Si deux contributions peuvent
partager une identité de « position », le schéma a affirmé qu'elles sont la même
position — sans auteur, sans base et sans possibilité de contester. La structure
peut transformer une interprétation en fait apparent sans que personne n'écrive
une phrase.

CCR remplace les identités sémantiques partagées non attribuées par des relations
sémantiques attribuées. Là où une identité partagée affirmerait que deux
contributions sont la même position, une relation enregistre qu'une partie
déclare un lien entre elles — ce qui est un énoncé, tenu par quelqu'un, et donc
contestable. Le changement n'est pas cosmétique : une identité n'a aucun
emplacement d'attribution à remplir ; une relation en a un, par construction.

La distinction mûre ajoute une seconde exigence facile à manquer. Nommer une
origine ne suffit pas. Un schéma offrant une origine `SOURCE`, dans laquelle une
transcription humaine peut être écrite, produira des enregistrements affirmant
qu'un expert a soutenu quelque chose qu'il n'a jamais soutenu. Le champ d'origine
serait renseigné et l'enregistrement resterait faux. La question n'est donc pas
seulement *ce que cet enregistrement déclare comme origine*, mais *si cette
origine aurait réellement pu produire cet enregistrement par un chemin qui
existe*.

La fondation exige donc deux choses conjointement :

```text
1. une origine sémantique attribuable
2. un chemin de production légitime pour cette origine
```

**Ce que cela ne signifie pas.** Une origine attribuable ne suffit pas à elle
seule — c'est tout l'objet de la seconde clause. Une origine nommée n'est pas
automatiquement une origine légitime. De même, ce n'est pas affirmer que des
identités sémantiques explicites seraient interdites par principe : l'objection
porte sur l'identité non attribuée, non sur l'idée qu'un contrat puisse définir
une identité adossée à un chemin de production légitime.

---

## F8 — `MATERIAL, ADDUCTION, AND EVIDENTIARY MERIT MUST REMAIN DISTINCT`

Dès lors qu'un système détient des documents, des journaux, des extraits et des
références, le mot « preuve » se met à faire trois métiers à la fois, et les
trois se disjoignent sous la pression.

CCR les sépare :

```text
RÉTENTION                  ≠  ADDUCTION
ADDUCTION                  ≠  VALEUR PROBANTE
VALIDATION DÉTERMINISTE    ≠  VALIDATION DU FOND
```

**La rétention n'est pas l'adduction.** Le matériau et les actes qui le
mobilisent demeurent des concepts canoniques distincts. Détenir un document n'est
pas s'en servir. Un matériau retenu ne devient pas une adduction du seul fait
d'être présent, et l'adduire ne change pas ce que le matériau retenu lui-même
signifie.

**L'adduction n'est pas la valeur probante.** Verser une pièce au débat, avec une
orientation déclarée, est un acte historique. Cela établit qui a mobilisé quoi,
vers quoi, et comment il l'a caractérisé. Cela n'établit rien quant à savoir si
la pièce soutient la position. `SUPPORTS` est une orientation déclarée, non une
preuve de vérité ; `OBJECTS_TO` n'est pas une preuve de fausseté.

**La validation déterministe n'est pas la validation du fond.** CCR peut vérifier
mécaniquement les propriétés structurelles d'une citation. Un tel contrôle est
exact et dit seulement que la citation tient structurellement. Savoir si le
passage cité porte réellement sur la cible n'est pas ce que CCR vérifie, et la
conception refuse qu'un contrôle structurel réussi se lise comme un contrôle de
fond réussi :

```text
HELD_AND_RESOLVABLE   ≠  FIABLE
PERSISTED             ≠  MERITS_VALIDATED
MODEL_ASSISTED        ≠  MODEL_TRUTH
```

Trois tentations de conception ont été déclinées ici : un modèle générique
énoncé-vers-preuve qui n'opérait aucune de ces distinctions, des champs de score
et de fiabilité qui auraient comprimé les trois en un seul chiffre, et
l'ambiguïté du mot « preuve » lui-même.

**Ce que cela ne signifie pas.** L'adduction n'est pas épistémiquement neutre —
verser une pièce est un acte signifiant, et CCR l'enregistre comme tel. Et rien
de tout cela n'implique que la vérité soit inconnaissable. CCR renonce à calculer
la valeur probante ; il n'affirme pas que cette valeur n'existe pas ou ne saurait
être établie par quiconque.

---

## F9 — `RECONCILIATION AUTHORITY DOES NOT PROPAGATE BY IMPLICATION`

La réconciliation est le lieu où des actes humains peuvent acquérir des effets de
réconciliation explicites, ce qui rend le système particulièrement vulnérable à
une sur-lecture de ce que chaque acte autorise.

La tentation est la propagation. CCR propose ; un humain répond ; donc la réponse
tranche. L'humain a accepté ; donc la proposition a été adoptée. L'affaire est
close ; donc l'affaire est résolue. Chaque étape se lit comme l'interprétation
naturelle de la précédente, et chacune promeut discrètement un acte en un acte
plus fort.

CCR type et borne plutôt chaque maillon de la chaîne :

```text
PROPOSITION                       ≠  AUTORITÉ DE DÉCISION
RÉPONSE HUMAINE À UNE PROPOSITION ≠  ACTE DE RÉCONCILIATION FAISANT AUTORITÉ
ACTE FAISANT AUTORITÉ             ≠  EFFETS SECONDAIRES NON DÉCLARÉS
EFFET DÉCLARÉ                     ≠  VÉRITÉ / CONVERGENCE / ACCORD DES EXPERTS
```

L'autorité est explicitement typée et bornée.

La plus contre-intuitive de ces relations est la deuxième, et c'est la
plus claire illustration de la fondation. Une réponse humaine à une proposition
**est** un acte humain. Elle est enregistrée, attribuée et réelle. Elle n'est pour autant
*pas* l'acte de réconciliation faisant autorité, parce que répondre à une
proposition et accomplir une réconciliation aux effets déclarés sont deux gestes
différents, aux périmètres différents. CCR les conserve comme des
enregistrements séparés plutôt que d'inférer le second depuis le premier.

Deux non-équivalences portent la distinction dans le schéma :

```text
RÉPONSE ACCEPT     ≠  ACTE DE RÉCONCILIATION FAISANT AUTORITÉ
OPTION RÉPONDUE    ≠  OPTION ADOPTÉE
```

L'option au sujet de laquelle quelqu'un a répondu n'est pas pour autant l'option
adoptée ; `ACCEPT` n'est pas `ADOPTS`. Les tentations de conception déclinées ici
— `CONVERGED`, des statuts de type « résolu », `ACCEPT` comprimé en adoption, un
cycle de vie global ouvert/fermé — sont autant de versions du même raccourci.

Ce que CCR y gagne est étroit et inhabituel : la capacité d'enregistrer une issue
sans prétendre que cette issue est la vérité.

**Ce que cela ne signifie pas.** L'autorité humaine dans CCR est réelle et
normative — cette fondation contraint la propagation, non l'autorité. Un acte
humain de réconciliation aux effets déclarés produit véritablement ces effets
dans le périmètre qu'il déclare. Ce qu'il ne produit pas, c'est la vérité, la
convergence ou l'accord des experts, et il ne produit pas d'effets qu'il n'a pas
déclarés.

---

## F10 — `CONTEXT ≠ MANDATE`

`F10` est l'endroit où CCR retourne sa discipline de contexte vers son propre
chemin de proposition assistée.

Lorsque CCR déclenche un modèle pour son propre compte — pour proposer une
réconciliation — il devient la partie qui assemble le contexte de ce modèle. Le
cadrage par défaut de cette tâche est la commodité : donnez-lui davantage, il
fera mieux. « Plus de mémoire » est exactement ce genre de tentation, de même que
sa version spécifique ici — réutiliser la session native d'un expert comme
contexte de la proposition — qui promouvrait une continuité cognitive en autorité
de contexte de proposition.

Le refus a trois volets :

```text
CONTEXTE LISIBLE / DISPONIBLE  ≠  AUTORITÉ / MANDAT
CONTEXTE                       ≠  PÉRIMÈTRE
LE CONTEXTE DOIT ÊTRE EXPLICITEMENT GOUVERNÉ
```

Le premier est le titre. Donner à lire à un modèle ne lui donne pas autorité sur
ce qu'il lit. Donner du contenu n'est pas donner un mandat.

Le second est plus tranchant en pratique. Le contexte est ce qui a été montré au
modèle ; le périmètre est ce que la proposition est autorisée à traiter. Ils sont
calculés différemment et ne doivent pas dériver l'un vers l'autre — une unité
présente au contexte ne devient pas pour autant une unité considérée, et le
contexte n'élargit jamais le périmètre.

Le troisième rend les deux premiers opposables. Le contexte de proposition est un
ensemble de sources explicite, tiré d'un instantané canonique de CCR, borné,
attribuable et auditable. Ce sont ces propriétés qui permettent d'examiner une
proposition après coup plutôt que de simplement lui faire confiance. Elles
excluent aussi toute une classe de substitutions discrètes, car un contexte qui
n'est pas celui déclaré n'est plus celui qui a été audité. Le résumé automatique
est l'archétype du geste refusé : une opération qui a l'air purement technique
alors qu'elle change ce qui a réellement été donné au modèle.

Trois conséquences en découlent directement :

```text
MÉMOIRE NATIVE            ≠  autorité de contexte de proposition
TRANSFORMATION DU CONTEXTE ≠  transport neutre
ORDRE DES ENTRÉES          ≠  importance / préférence
```

**Ce que cela ne signifie pas.** Cette frontière a plusieurs limites précises, et
chacune compte.

Une session fraîche est exigée pour le **chemin de proposition assistée de
réconciliation** spécifiquement. Ce n'est pas une politique universelle de CCR,
et cela ne s'étend pas aux slots d'expert.

La frontière du contexte autorisé est une frontière **épistémique**, non une
frontière de confinement. Elle dit ce que CCR a choisi de fournir. Ce n'est pas
un confinement du système de fichiers du fournisseur, et le workspace n'est pas
une frontière de sécurité du système de fichiers — CCR ne surveille ni ne
restreint ce qu'une CLI fournisseur lit sur le disque.

Un instantané CCR partagé garantit que les unités de contexte ont été observées
de manière cohérente. Il ne garantit **pas** un même état Git ; CCR ne capture
aucun contexte Git.

Et CCR peut établir quel contexte canonique il a fourni. Il ne peut pas établir
ce à quoi le modèle a intérieurement prêté attention. Auditer l'entrée n'est pas
auditer la lecture.

---

## F11 — `TEMPORAL INTEGRITY`

La dernière fondation scinde un mot qui dissimule deux obligations différentes.

```text
INTÉGRITÉ VERS LE PASSÉ   ce qui s'est produit reste ce qui s'est produit
APPLICABILITÉ PRÉSENTE    ce qui s'applique maintenant suit une sémantique
                          de domaine explicite
```

Les systèmes qui conservent une histoire se voient constamment demander quel
enregistrement est *courant*, et la réponse la moins coûteuse est : le plus
récent. Le « dernier arrivé l'emporte » est simple et n'exige aucune sémantique
de domaine, ce qui est précisément pourquoi il est tentant.

CCR le décline comme règle générale :

```text
FAIT HISTORIQUE     ≠  ÉTAT COURANT
RÉCENCE SEULE       ≠  ACTUALITÉ
L'ACTUALITÉ EST PROPRE À UN DOMAINE, ET PEUT AVOIR
DES DIMENSIONS INDÉPENDANTES
CHANGEMENT COURANT  ≠  RÉÉCRITURE RÉTROACTIVE
```

La troisième de ces relations est difficile à anticiper et évidente après coup.
Dans le domaine de la réconciliation, savoir si une décision humaine est courante
et savoir si son effet de clôture est courant sont **deux questions distinctes
aux réponses distinctes**. Un acte ultérieur peut superséder une décision sans
toucher à sa clôture, ou retirer une clôture sans superséder la décision. Un
unique indicateur « est-ce encore courant ? » ne peut pas représenter cela, et
imposerait une même réponse aux deux.

La quatrième est ce qui protège le passé. Superséder une décision ne l'efface
pas, ne la réécrit pas et ne la rend pas rétrospectivement fausse. C'était un
acte ; cela reste un acte ; ce qui change, c'est ce qui s'applique maintenant.
Deux tentations se tiennent de part et d'autre : des champs
`ACTIVE`/`SUPERSEDED` représentant l'actualité directement comme un statut plutôt
que la dérivant de relations historiques explicites, et l'attraction permanente
du « dernier arrivé l'emporte ».

Le recadrage tient en ceci : « courant » n'est pas une propriété que porte un
objet historique. C'est une relation entre cet objet et la sémantique
d'applicabilité d'un domaine donné. C'est ainsi que CCR laisse changer le présent
sans faire mentir le passé.

**Ce que cela ne signifie pas.** La récence n'est pas hors de propos — cette
fondation dit que la récence **seule** n'est pas une autorité de succession, non
que la nouveauté ne compte jamais. Un domaine peut légitimement employer l'ordre
comme l'un des intrants de sa sémantique de succession là où sa sémantique le
rend pertinent ; ce qu'il ne peut pas faire, c'est traiter l'ordre comme la règle
entière. La supersession n'est pas un effacement. Et ce n'est pas affirmer que
tout l'état de CCR serait append-only : l'append-only est une propriété de
journaux précis, énoncée là où elle vaut, non un énoncé architectural global.

---

# Comment les fondations se renforcent l'une l'autre

Les douze sont séparables sans être indépendantes. Une poignée d'interfaces porte
l'essentiel du poids, et elles gagnent à être lues comme des interfaces plutôt
que comme des causes : un choix de conception donné est le plus souvent soutenu
par plusieurs fondations à la fois et n'appartient à aucune d'elles seule.

**`F1` et `F2`** sont les deux moitiés de l'erreur auto-cohérente. `F1` bloque le
raccourci de la concordance vers la preuve. `F2` bloque le raccourci d'une bonne
source vers la mauvaise sorte de question. L'une sans l'autre laisse la porte
ouverte : un système peut être scrupuleux dans le décompte des relecteurs et
trancher malgré tout une question normative au moyen d'un banc d'essai.

**`F3`, `F5A` et `F10`** portent toutes sur les sessions, et les coupent de trois
manières différentes. `F3` dit que la continuité cognitive d'une session n'est pas
le relevé épistémique de CCR. `F5A` dit qu'une session n'est pas une identité de
protocole. `F10` dit que la mémoire d'une session n'est pas un contexte de
proposition autorisé. Le même objet se voit refuser trois promotions
différentes, pour trois raisons différentes.

**`F4` et `F6`** se rencontrent partout où une lacune atteint un écran. `F4`
établit que CCR ne doit pas combler ce qu'il n'a pas observé ; `F6` établit que
la surface ne doit pas le combler non plus. Un journal absent rendu comme un zéro
viole les deux.

**`F4` et `F7`** se rencontrent au schéma. `F4` contraint ce que CCR peut
affirmer au vu de ce qu'il a observé ; `F7` contraint ce que le modèle de données
peut affirmer structurellement. Un schéma incapable de représenter « inconnu »
force une violation de `F4` dès l'écriture — la forme de l'enregistrement rend la
réponse honnête indicible.

**`F5B` et `F6`** se rencontrent au chiffre affiché. `F5B` maintient l'engagement,
l'observation, l'estimation et la politique séparés dans le cœur ; `F6` empêche
la surface de les refondre pour l'affichage. Un montant fournisseur affiché là où
une estimation a sa place est précisément cette refonte.

**`F7`, `F8` et `F9`** forment la colonne vertébrale représentationnelle des
domaines sémantiques de CCR. `F7` gouverne la manière dont une structure attribue ;
`F8` gouverne la manière dont le matériau et sa mobilisation restent séparés de la
valeur probante ; `F9` gouverne la manière dont les actes et les effets sont typés
et bornés. Ensemble, elles décrivent un système qui représente progressivement
davantage tout en concluant progressivement moins.

**`F9` et `F11`** se rencontrent à la supersession. `F9` exige que les effets
soient déclarés et bornés ; `F11` exige que l'actualité soit propre à un domaine
et que l'histoire soit préservée. L'actualité à deux dimensions de la
réconciliation vit à cette intersection, et aucune des deux fondations ne la
produit seule.

---

# Le motif récurrent : la promotion sémantique

À travers ces fondations, un motif récurrent devient visible : beaucoup des modes
de défaillance que CCR traite ne commencent pas par un fait primitif faux. Ils
commencent lorsqu'un fait, un acte, une relation ou une représentation légitime
se voit silencieusement faire dire davantage que ce qu'il est autorisé à
signifier.

```text
LEGITIMATE X
→ SILENTLY PROMOTED
→ STRONGER Y
→ WITHOUT SUFFICIENT AUTHORITY
```

Les occurrences parcourent l'ensemble. L'accord — un fait réel sur ce que les
relecteurs ont dit — promu en preuve. Un engagement réellement pris par CCR,
promu en exécution fournisseur qu'il n'a jamais observée. Une valeur correctement
détenue, promue par une surface en un sens métier que personne n'a établi. Un
champ d'origine renseigné, promu en origine légitime. Une orientation déclarée,
promue en valeur probante. Une réponse humaine enregistrée, promue en acte
faisant autorité. Un contexte disponible, promu en mandat. Un ordre, promu en
autorité de succession.

Dans ces cas, le point de départ est légitime. C'est ce qui rend la promotion
difficile à saisir : il n'y a aucune entrée fausse à détecter, et aucune étape
manifestement erronée. Le défaut réside dans la force de la conclusion,
relativement à l'autorité réellement détenue.

Deux choses doivent être dites de ce motif.

**Ce n'est pas une treizième fondation.** Il décrit ce que les douze ont en
commun ; ce n'est pas une treizième frontière à côté d'elles, et le traiter comme
telle reviendrait à compter double, puisque chaque occurrence du motif est déjà
une occurrence d'une fondation précise.

**Les douze n'en ont pas été déduites.** Le motif est quelque chose que l'on
remarque en parcourant les fondations, non une théorie unique dont elles
dériveraient. Chacune tient sur le problème précis qu'elle traite.

---

# Ce que la maturité signifie pour CCR

CCR part d'une définition de la maturité qui n'est pas l'habituelle :

```text
CCR MATURITY
= MORE CAPABILITY
+ MORE OBSERVABILITY
+ FEWER UNAUTHORIZED INFERENCES
```

Les deux premiers termes sont conventionnels. Le troisième est là où la
définition justifie son existence, et il est régulièrement mal lu.

`FEWER UNAUTHORIZED INFERENCES` signifie éliminer les promotions sémantiques que
ne justifient pas les observations, actes, relations ou autorités réellement
enregistrés.

Cela ne signifie **pas** :

```text
= moins de raisonnement
= moins de dérivation
= moins de capacité
```

Cela signifie :

```text
= moins de promotions sémantiques non autorisées
= une attribution plus stricte
= un bornage plus strict
= des frontières d'autorité plus précises
```

La distinction est facile à perdre et importante à tenir. CCR porte une quantité
considérable de machinerie représentationnelle : la structure de controverse, les
matériaux probatoires et l'adduction, les actes de réconciliation à effets typés,
une sémantique temporelle à dimensions indépendantes, des read models dérivés,
des propositions assistées gouvernées. Chacune est un *gain* dans ce que CCR peut
exprimer et calculer.

Ce qui se resserre en parallèle, c'est ce que chacune de ces constructions est
autorisée à affirmer. Un modèle plus riche aux significations autorisées plus
étroites n'est pas un système plus petit. C'est un système plus précis.

La formulation à retenir est que **CCR ne se contente pas de minimiser sa
puissance — il spécialise ses puissances.** Une capacité qui dit exactement une
chose, et la dit avec attribution et périmètre, est plus utile qu'une capacité
qui dit quelque chose de vaguement plus fort et ne peut pas être auditée. Les
refus contenus dans ces fondations ne sont pas de la modestie. Ils sont le prix
de pouvoir se fier à ce que le système dit effectivement.

---

# Rapport à la doctrine et aux spécifications

CCR documente sa conception selon trois registres, et il vaut la peine d'être
explicite sur celui dont il s'agit ici.

```text
DESIGN FOUNDATIONS
= les principes de conception dont CCR part, et pourquoi

DOCTRINE
= ce que CCR affirme, et ce qu'il refuse d'affirmer

SPÉCIFICATIONS
= ce que les contrats courants de CCR garantissent
```

Ces fondations exposent la discipline de conception qui sous-tend CCR. Elles ne
remplacent ni la doctrine ni les spécifications courantes, et ne font autorité
sur aucune des deux. Là où une fondation et un contrat courant sembleraient
diverger, le contrat gouverne ce que fait le produit ; la fondation fournit un
contexte de conception et ne prévaut pas sur le contrat.

L'ensemble est un ensemble de travail. C'est ce que la conception tient
aujourd'hui, non une théorie close de l'orchestration fiable.
