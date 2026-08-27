# CCR Design History

**CCR — Contradictory Cross-Review / Contre-expertise croisée**

Ce document explique pourquoi CCR est devenu le système qu'il est : de quel
problème il est parti, quelles pressions sa conception a rencontrées, et quelles
distinctions il a fini par traiter comme porteuses.

C'est un compagnon de **Design Foundations**, qui expose les principes eux-mêmes.
Celui-ci explique comment la conception y est parvenue.

---

## Comment lire cette histoire

Cinq actes organisent ce qui suit. Ils sont une **organisation rétrospective** —
une manière de rendre lisible, après coup, le mouvement de la conception.

Ils ne sont pas un programme que CCR aurait annoncé puis exécuté, ni des phases
de développement officielles, ni la seule manière défendable de découper la
matière. Une autre organisation du même développement pourrait se soutenir.

Deux mises en garde supplémentaires importent davantage qu'il n'y paraît.

**C'est une histoire intellectuelle, pas une chronologie.** Elle suit ce qui a
été appris, non ce qui a été livré à quelle date. Aucune séquence de versions,
aucun compte rendu version par version, aucune frise de fonctionnalités.

**Le sens de la découverte allait vers l'avant.** Rien ici ne doit se lire comme
si le CCR mûr avait été visible dès le départ, ni comme si chaque modèle
antérieur avait existé pour être remplacé. Plusieurs distinctions de CCR existent
parce qu'une conception parfaitement raisonnable a rencontré une friction, et que
cette friction s'est révélée être une frontière manquante. Lu vers l'avant, cela
ressemble à une suite de réparations locales. Lu à rebours, ces réparations
s'alignent — ce qui est une observation sur la forme du développement, non la
preuve d'un plan.

---

## Act I — The self-consistent error

### Le problème dont CCR part

CCR commence par une observation sur la défaillance, plus précise que « les
modèles se trompent ».

Une représentation erronée n'est pas nécessairement corrigée par le travail qui
lui succède. Elle peut être élaborée. Chaque étape suivante est localement
raisonnable, se réfère à la précédente et ajoute de la solidité apparente — sans
ajouter la moindre correspondance au réel. Le résultat est cohérent de
l'intérieur, défendable en chaque point, et faux au niveau du cadre. Rien en aval
ne le rattrape, parce que tout ce qui est en aval est cohérent avec elle.

C'est l'**erreur auto-cohérente**, et c'est le problème d'origine de tout le
système.

### La réponse évidente, et son propre piège

La réponse naturelle est la confrontation : ne pas laisser le cadre d'un
relecteur tenir sans opposition. Opposer un relecteur distinct et voir s'il
survit.

CCR prend cette réponse au sérieux et construit dessus. Mais organiser la
confrontation porte un piège dans lequel il est facile de tomber, précisément
parce qu'il a l'allure de la rigueur. Si un relecteur peut se tromper, en
interroger deux — et si les deux disent la même chose, cela doit bien compter.

Cela compte pour quelque chose. Ce que cela ne fait pas, c'est établir un fait.
Deux relecteurs peuvent partager un cadrage, un angle mort, ou simplement la même
lecture d'un artefact ambigu ; et le second peut avoir été influencé par le
premier. Les compter ne résout aucune de ces deux possibilités. L'erreur
auto-cohérente n'est pas vaincue par l'ajout d'une seconde voix cohérente — c'est
exactement le genre d'erreur qu'une seconde voix cohérente peut renforcer.

C'est `F1` : **l'accord n'est pas une preuve.** CCR sépare l'accord et le nombre
de modèles de la preuve factuelle, et attribue l'autorité factuelle à ce qui
établit réellement l'énoncé.

### La pression que cela a créée

La pression s'est manifestée comme une famille de possibilités architecturales
attirantes : des statuts qui déclareraient un désaccord résolu, et une valeur de
convergence calculée à partir des positions des relecteurs. Ce sont des
tentations de conception que CCR décline, et `CONVERGED` appartient à la même
famille — CCR ne traite pas de telles sémantiques de convergence comme faisant
autorité.

Le problème de telles valeurs n'a jamais été qu'elles soient difficiles à
calculer. C'est que les calculer fabriquerait une autorité que personne ne
détient.

### La seconde moitié du même problème

Refuser de compter l'accord ne suffit pas, car l'erreur auto-cohérente a une
autre entrée.

Une source peut être parfaitement légitime dans son propre domaine et rester la
mauvaise autorité pour la question posée. Un banc d'essai tranche la performance
et ne tranche rien sur l'opportunité d'une fonctionnalité. Une spécification
tranche ce qui était voulu, non le comportement effectif. La source est bonne ;
la discordance est entre ce qu'elle peut établir et la nature de la proposition.

C'est `F2` : **la nature d'un énoncé borne sa base légitime.** CCR distingue les
questions factuelles, interprétatives et normatives et les traite comme exigeant
des bases structurellement différentes — et cela aide à expliquer pourquoi CCR ne
fonctionne pas comme un moteur d'arbitrage. Un système qui classerait les
positions par la seule qualité de leur source tranchera avec assurance un
désaccord normatif au moyen de preuves factuelles, et un désaccord interprétatif
au moyen de la lecture la mieux citée. Ce sont deux erreurs de catégorie
revêtues du costume de la rigueur.

### Un renversement sur lequel s'arrêter

`F2` a produit la première illustration nette d'un mouvement qui revient tout au
long de cette histoire.

Une tentation de conception antérieure exigeait que les désaccords soient
**classés d'emblée**, sur l'hypothèse raisonnable que connaître la nature de la
question était un préalable à son traitement. Cette classification obligatoire a
été écartée. Ce qui l'a remplacée est plus faible et plus honnête : qualifier la
nature d'une controverse est devenu facultatif, attribué à qui l'a qualifiée,
autorisé à rester inconnu, et sans conséquence automatique.

La conception a renoncé à une hypothèse qu'elle avait d'abord tenue pour
nécessaire, et a gagné une représentation capable de rester honnête sur ce
qu'elle savait.

Aucune des deux fondations n'affirme davantage qu'elle ne le devrait. L'accord
conserve une valeur informationnelle réelle — il peut orienter l'attention, ou
indiquer qu'une question n'est pas la question intéressante. Et les trois natures
de question sont une distinction analytique, non une taxonomie obligatoire et
exhaustive dans laquelle chaque désaccord devrait entrer ; CCR refuse d'énumérer
une liste fermée, et n'offre aucune autorité interprétative finale vers laquelle
se tourner lorsque l'interprétation s'épuise.

---

## Act II — Preserving independent minds without inventing state

### La tension

Une fois la confrontation posée comme mécanisme, une question pratique arrive
immédiatement et se révèle ne pas être une question de plomberie : sur de
nombreux tours, que doivent retenir les relecteurs, et qui détient cette
mémoire ?

Les deux réponses évidentes sont structurellement insatisfaisantes. Leur donner
une conversation partagée, et les continuités conversationnelles distinctes
s'effondrent en une seule. Ne leur donner aucune continuité, et chaque tour
repart de zéro, ce qui n'est pas de la relecture mais une suite de premières
impressions.

### La distinction qui a résolu cela

La résolution sépare deux formes de continuité qui, jusque-là, se confondaient
sous un même mot.

La session native de chaque expert auprès de son fournisseur porte la
**continuité cognitive** — le fil du raisonnement, le cadrage accumulé, ce que
cette session soutient. L'état canonique persisté par CCR porte la **continuité
épistémique** — le relevé attribuable et auditable de ce qui a effectivement été
dit, transmis, décidé et enregistré.

C'est `F3`, et les deux sont complémentaires et non substituables. CCR ne
reconstitue pas ce qu'un expert pensait à partir de sa transcription, et il ne
verse pas son relevé canonique dans les conversations des experts comme si
c'était la même chose.

Deux alternatives structurelles se tiennent de part et d'autre de cette ligne.
L'une fait d'une personne la couche de transport entre les experts, acheminant le
contenu à la main. L'autre dérive l'état de CCR depuis ce que contiennent les
sessions fournisseur. Chacune peut se lire comme un effondrement des deux
continuités dans une direction différente — la première en faisant de l'état
partagé un artefact manuel, la seconde en faisant du relevé canonique un dérivé
de la mémoire du fournisseur.

Ce à quoi CCR est parvenu est une mémoire de processus commune sans mémoire
conversationnelle commune : chaque relecteur garde sa propre continuité, et
l'état partagé vit en dehors des deux conversations.

### La seconde pression : les lacunes

Séparer les continuités expose un problème différent, car CCR tient désormais le
relevé d'un processus qui touche au monde extérieur — et un tel relevé est en
permanence à un petit pas de dire plus que ce qui a été observé.

Une sonde expire. Un sous-processus est tué et ne rapporte rien. Un journal n'a
aucune entrée pour une période antérieure à son existence. Dans chaque cas, le
système détient quelque chose de moindre qu'une observation, et dans chaque cas
un geste local est tentant : combler. L'expiration devient un échec. Le journal
manquant devient zéro. L'absence de trace devient « rien ne s'est produit ».

Chacun de ces gestes est une petite fabrication qui produit un état indiscernable,
en aval, d'un état réellement observé.

C'est `F4` : **l'observation borne les énoncés.** `UNKNOWN` est conservé plutôt
que résolu ; l'observation manquante reste distincte d'un état positif ;
l'inférence est contrainte aux entrées réellement observées. La conception
accepte un état explicitement incomplet plutôt qu'un état complet fabriqué sans
base suffisante — une préférence qui coûte du confort, car un système qui refuse
de combler ses propres lacunes doit les exposer.

### Ce que cet acte n'établit pas

Trois limites méritent d'être énoncées, car c'est ici que la sur-lecture est la
plus facile.

Des sessions distinctes ne sont **pas** une indépendance statistique démontrée.
CCR les sépare structurellement ; il n'affirme rien de leur relation statistique,
et deux sessions séparées peuvent partager beaucoup.

La continuité épistémique n'est **pas** la vérité. Un relevé attribuable et
auditable de ce qui a été dit n'est pas un relevé de ce qui est.

Et `F4` ne signifie pas que CCR n'infère jamais. L'inférence qualifiée reste
pleinement légitime lorsque sa base et son statut sont explicites. Ce qui est
interdit, c'est une inférence pouvant se présenter comme une observation.

---

## Act III — Decomposing and governing the orchestrator

### Pourquoi l'orchestrateur a cessé d'être une seule chose

À travers les deux premiers actes, CCR est largement un bloc sémantique unique :
la chose qui exécute les relecteurs et tient le relevé. Cet acte est celui où ce
bloc se disjoint, sous la pression de questions qui partageaient une même
réponse.

### Qui agit ?

Une manière intuitive de parler d'un run passe par le nom du fournisseur : la CLI
d'un fournisseur est l'auteur, celle d'un autre est le challenger. C'est concret
et tout le monde le comprend — et cela fait apparaître trois dimensions comme une
seule : qui agit, avec quel moteur, dans quel fil conversationnel.

La friction qui l'expose mérite d'être nommée précisément, car c'est le cas qui
rend l'ancien vocabulaire inutilisable plutôt que simplement imprécis. Sous le
régime fournisseur-comme-identité, un run avec **le même fournisseur des deux
côtés** est quasi irreprésentable : si l'auteur *est* un fournisseur et le
challenger *est* un autre, deux auteurs de la même marque sont une contradiction
plutôt qu'une configuration.

C'est `F5A`. `ExpertSlot` est le rôle de protocole, et le rôle est l'identité.
`ProviderBinding` est l'affectation technique d'un moteur à un slot.
`NativeSession` est la continuité conversationnelle de ce slot. La configuration
à fournisseur unique n'a alors plus rien de remarquable : deux rôles, un type de
moteur, deux sessions.

La leçon est que l'identité intellectuelle d'un rôle de relecture appartient au
protocole, non à la marque du moteur qui l'exécute. Le fournisseur exécute
l'expert ; il ne définit pas l'expert.

Cela ne fait pas de la diversité de fournisseurs une exigence de protocole. CCR
l'autorise et ne l'impose pas — et savoir si employer des fournisseurs différents
améliore réellement la qualité de la relecture n'est **pas établi**. `F5A` est un
énoncé d'hygiène représentationnelle, non un énoncé sur les bénéfices d'un
mélange de fournisseurs.

### Qu'est-ce que CCR engage, observe, estime, autorise ?

La seconde question devient aiguë dès l'instant où un orchestrateur se met à
dépenser les ressources de quelqu'un.

Quatre choses se tiennent proches et sont constamment confondues : ce que CCR
s'est durablement engagé à faire, ce qu'il a réellement observé de ce qui s'est
passé, ce qu'il a calculé comme grandeur dérivée, et ce qu'il était autorisé à
engager au départ.

Elles ont des conditions de vérité différentes. Un engagement est exact — CCR l'a
écrit. Une observation dépend de ce que le fournisseur a rapporté, qui peut être
partiel ou absent. Une estimation dépend d'un modèle de tarification. Une
politique est la règle d'admission propre à CCR, qui n'est pas le quota du
fournisseur.

Trois confusions étaient disponibles et sont déclinées par conception : traiter
une invocation comme équivalente à un appel fournisseur, forcer les totaux de
jetons en une grandeur normalisée unique, et présenter un montant monétaire
fourni par le fournisseur comme s'il s'agissait de l'estimation propre à CCR.
Chacune est localement commode, et chacune détruit une différence qui compte
lorsque quelque chose tourne mal.

C'est `F5B`. La règle qui gouverne est que CCR rend exact ce qu'il contrôle et
qualifié ce qu'il ne peut qu'observer ou estimer — et qu'il n'élève pas le second
au niveau du premier par commodité de présentation.

Un principe de conception l'accompagne, et il gouverne jusqu'où CCR consent à
agir de lui-même : **on ne construit pas l'autonomie avant que le compteur et le
frein existent.** Une capacité en mesure de dépenser des ressources ne devrait
pas précéder la comptabilité et les contrôles d'admission qui la bornent.

Les quatre non-équivalences valent dans tous les sens. Une invocation n'est pas
une exécution fournisseur confirmée. Une grandeur d'usage observée n'est pas
l'usage complet. Une estimation de coût n'est pas une facture. Le budget de CCR
n'est pas le quota du fournisseur.

### La frontière de surface

Cet acte a un troisième mouvement, et il concerne l'endroit où tout cela devient
visible.

Une distinction peut être correctement représentée dans le cœur et détruite en
chemin vers un écran. Cette défaillance vient en deux classes. Dans la première,
les faits qui parviennent à la surface sont corrects et la surface leur donne un
sens que le système n'a jamais établi — un montant fournisseur apparaissant là où
une estimation a sa place, une affordance de reprise apparaissant là où aucun
geste de reprise n'existe, un client triant des enregistrements dans un ordre que
le serveur n'a jamais affirmé. Dans la seconde, la surface fabrique une
complétude apparente en comblant ce que le cœur a délibérément laissé ouvert : le
journal absent rendu comme un zéro, c'est-à-dire le refus de `F4` défait à la
dernière étape.

C'est `F6`. Le cockpit est défini comme une **surface au-dessus** de CCR, non
comme un second moteur CCR : la projection de présentation est additive et ne
peut pas redéfinir l'état faisant autorité. La généralisation est plus large que
le cockpit — les surfaces et les transports acheminent des actes métier sans
devenir des autorités métier.

Ce n'est pas une dégradation de l'interface. Une présentation riche est légitime,
et le sens présentationnel l'est aussi : une surface peut organiser, expliquer,
contextualiser, regrouper et mettre en avant. La hiérarchie visuelle n'est pas
intrinsèquement une autorité métier, et le frontend n'a pas à être un rendu
passif. Ce qu'une surface ne peut pas faire, c'est créer, altérer ou compléter
une sémantique métier faisant autorité.

### Le motif de cet acte

CCR est devenu plus fiable ici en donnant à des questions différentes des
représentations canoniques différentes — les questions d'identité, de ressources
et de présentation ont chacune obtenu leur propre vocabulaire au lieu d'en
partager un seul.

C'est un motif, et il doit se lire comme tel. Ce n'est pas un principe caché dont
les distinctions de cet acte dériveraient ; chacune tient sur le problème précis
qu'elle traite.

---

## Act IV — Representing more while concluding less

### Le paradoxe apparent

Le CCR plus tardif fait quelque chose qui, vu de l'extérieur, paraît
contradictoire. Son modèle sémantique s'enrichit considérablement — structure de
controverse, matériaux probatoires et adduction, actes de réconciliation à effets
typés, sémantique temporelle — pendant que l'autorité de chaque représentation
individuelle se fait *plus étroite*.

La résolution est que ce sont là un seul et même mouvement. Chaque chose nouvelle
que CCR peut représenter est une occasion nouvelle de la représenter comme plus
forte qu'elle n'est, et le rétrécissement est ce qui rend l'enrichissement sûr.

### La structure comme surface d'autorité

Le premier mouvement concerne le désaccord lui-même, et il part d'une découverte
sur les schémas.

Un modèle de données n'est pas un contenant neutre. Si deux contributions peuvent
partager une identité de « position », le schéma a affirmé qu'elles sont la même
position — sans auteur, sans base et sans possibilité de contester. La structure
peut transformer une interprétation en fait apparent sans que personne n'écrive
une phrase.

CCR remplace les identités sémantiques partagées non attribuées par des
**relations sémantiques attribuées**. Là où une identité partagée affirmerait que
deux contributions sont la même position, une relation enregistre qu'une partie
déclare un lien entre elles — un énoncé, tenu par quelqu'un, et donc contestable.
Une identité n'a aucun emplacement d'attribution à remplir ; une relation en a
un, par construction.

La forme mûre de `F7` ajoute une seconde exigence facile à manquer : nommer une
origine ne suffit pas. Un schéma offrant une origine `SOURCE`, dans laquelle une
transcription humaine peut être écrite, produira des enregistrements affirmant
qu'un expert a soutenu quelque chose qu'il n'a jamais soutenu. Le champ d'origine
serait renseigné et l'enregistrement resterait faux. L'exigence est donc à la
fois une origine sémantique attribuable **et** un chemin de production légitime
pour elle.

### Matériau, mobilisation, valeur probante

Le second mouvement concerne la preuve, et il commence par le constat que le mot
fait trois métiers à la fois.

`F8` les sépare. **La rétention n'est pas l'adduction :** le matériau et les
actes qui le mobilisent demeurent des concepts canoniques distincts, et détenir
un document n'est pas s'en servir. **L'adduction n'est pas la valeur probante :**
verser une pièce au débat avec une orientation déclarée est un acte historique
qui établit qui a mobilisé quoi et comment il l'a caractérisé, et qui n'établit
rien quant à savoir si la pièce soutient la position. **La validation
déterministe n'est pas la validation du fond :** un contrôle structurel sur une
citation est exact, et dit seulement que la citation tient structurellement.

Trois compressions ont été déclinées ici : un modèle générique énoncé-vers-preuve
qui n'opérait aucune de ces distinctions, des champs de score et de fiabilité qui
auraient réduit les trois à un seul chiffre, et l'ambiguïté du mot « preuve »
lui-même.

Rien de tout cela n'affirme que la vérité soit inconnaissable. CCR renonce à
calculer la valeur probante ; il ne prétend pas que cette valeur n'existe pas.

### Une autorité qui ne se propage pas

Le troisième mouvement porte sur les issues, et c'est là que la tentation est la
plus forte.

La réconciliation est le lieu où des actes humains peuvent acquérir des effets de
réconciliation explicites, ce qui rend le système particulièrement vulnérable à
une sur-lecture de ce que chaque acte autorise. CCR propose ; un humain répond ;
donc la réponse tranche. L'humain a accepté ; donc la proposition a été adoptée.
L'affaire est close ; donc l'affaire est résolue. Chaque étape se lit comme
l'interprétation naturelle de la précédente, et chacune promeut discrètement un
acte en un acte plus fort.

`F9` type et borne plutôt chaque maillon. CCR sépare la proposition, la réponse
humaine à une proposition et l'acte de réconciliation faisant autorité — et
sépare la clôture de la vérité, de la convergence et de l'accord des experts.

La part contre-intuitive mérite d'être dite sans détour. Une réponse humaine à
une proposition **est** un acte humain : enregistrée, attribuée, réelle. Elle
n'est pour autant pas l'acte de réconciliation faisant autorité, parce que
répondre à une proposition et accomplir une réconciliation aux effets déclarés
sont des gestes différents, aux périmètres différents. `ACCEPT` n'est pas
`ADOPTS` ; l'option au sujet de laquelle quelqu'un a répondu n'est pas pour
autant l'option adoptée.

Les raccourcis déclinés ici étaient `CONVERGED`, des statuts de type « résolu »,
`ACCEPT` comprimé en adoption, et un cycle de vie global ouvert/fermé qui aurait
fait du règlement une propriété de la controverse entière.

L'autorité humaine dans CCR demeure réelle et normative — `F9` contraint la
propagation, non l'autorité. Un acte aux effets déclarés produit véritablement
ces effets dans le périmètre qu'il déclare. Ce qu'il ne produit pas, c'est la
vérité, la convergence ou l'accord des experts, et il ne produit pas d'effets
qu'il n'a pas déclarés.

### Le temps, et les deux questions qu'il contient

Le quatrième mouvement scinde un mot qui dissimulait deux obligations : ce qui
s'est produit doit rester ce qui s'est produit, et ce qui s'applique maintenant
doit suivre une sémantique explicite.

Les systèmes qui conservent une histoire se voient constamment demander quel
enregistrement est courant, et la réponse la moins coûteuse est le plus récent.
Le « dernier arrivé l'emporte » n'exige aucune sémantique de domaine, ce qui est
précisément pourquoi il est tentant — et il voisine avec la tentation de
représenter l'actualité directement comme un champ de statut plutôt que de la
dériver de relations historiques explicites.

`F11` décline le « dernier arrivé l'emporte » comme règle générale. La part
difficile à anticiper et évidente après coup est que l'actualité peut avoir des
**dimensions indépendantes** : en réconciliation, savoir si une décision humaine
est courante et savoir si son effet de clôture est courant se révèlent être deux
questions distinctes aux réponses distinctes. Un unique indicateur « est-ce
encore courant ? » ne peut pas représenter cela, et imposerait une même réponse
aux deux.

L'intégrité vers le passé est ce qui protège le passé. Superséder une décision ne
l'efface pas, ne la réécrit pas et ne la rend pas rétrospectivement fausse.
C'était un acte ; cela reste un acte ; ce qui change, c'est ce qui s'applique
maintenant.

Les rétrécissements tiennent. La récence seule n'est pas une autorité de
succession — ce qui n'est pas affirmer que la nouveauté ne compte jamais ; un
domaine peut légitimement employer l'ordre comme l'un des intrants là où sa
sémantique le rend pertinent, mais non comme la règle entière. La supersession
n'est pas un effacement.

Le recadrage est que « courant » n'est pas une propriété que porte un objet
historique. C'est une relation entre cet objet et la sémantique d'applicabilité
d'un domaine donné — c'est ainsi que CCR laisse changer le présent sans faire
mentir le passé.

---

## Act V — CCR governs the context of its own assisted proposal path

### Une responsabilité nouvelle

À ce stade, CCR tient un relevé canonique riche et un ensemble de disciplines sur
ce que chacune de ses parties peut affirmer. Dans cette organisation
rétrospective, le cinquième acte ajoute une responsabilité nouvelle : CCR
assemble désormais aussi le contexte canonique fourni à un modèle assisté — le
modèle qu'il déclenche pour son propre compte afin de proposer une
réconciliation.

### La tentation, et sa forme

Le cadrage par défaut de cette tâche est la commodité : donnez-lui davantage, il
fera mieux. « Plus de mémoire » est exactement ce genre de tentation, de même que
la version disponible ici — réutiliser la session native d'un expert comme
contexte de la proposition, ce qui promouvrait une continuité cognitive en
autorité de contexte de proposition.

Rétrospectivement, cet acte et l'acte II peuvent se lire comme refusant des
effondrements apparentés dans des directions opposées.

### La distinction, en trois volets

`F10` est l'endroit où CCR retourne sa discipline de contexte vers son propre
chemin de proposition assistée :

```text
DONNER À LIRE  ≠  DONNER AUTORITÉ
CONTEXTE       ≠  MANDAT
```

Donner à lire à un modèle ne lui donne pas autorité sur ce qu'il lit.

Le second volet est plus tranchant en pratique. Le contexte est ce qui a été
montré au modèle ; le périmètre est ce que la proposition est autorisée à
traiter. Ils sont calculés différemment et ne doivent pas dériver l'un vers
l'autre : une unité présente au contexte ne devient pas pour autant une unité
considérée, et le contexte n'élargit jamais le périmètre.

Le troisième volet rend les deux premiers opposables. Le contexte de proposition
est un ensemble de sources explicite, tiré d'un instantané canonique de CCR,
borné, attribuable et auditable. Ce sont ces propriétés qui permettent d'examiner
une proposition après coup plutôt que de simplement lui faire confiance. Le
résumé automatique est l'archétype du geste refusé : une opération qui a l'air
purement technique alors qu'elle change ce qui a réellement été donné au modèle.

Trois conséquences en découlent directement :

```text
MÉMOIRE NATIVE             ≠  autorité de contexte de proposition
TRANSFORMATION DU CONTEXTE ≠  transport neutre
ORDRE DES ENTRÉES          ≠  importance / préférence
```

Ce que CCR rend gouvernable ici, ce n'est pas seulement ce qu'un modèle assisté
produit, mais la base canonique que CCR lui a lui-même fournie.

### Les rétrécissements qui gardent cet acte honnête

C'est ici qu'une lecture triomphante serait la plus tentante, et c'est ici que
les limites sont les plus précises.

Une **session fraîche** est exigée pour le chemin de proposition assistée de
réconciliation, spécifiquement. C'est une politique bornée à un chemin — non une
règle universelle de CCR, et sans extension aux slots d'expert.

La frontière du contexte autorisé est une frontière **épistémique**, non une
frontière de confinement. Elle dit ce que CCR a choisi de fournir. Ce n'est pas
un confinement du système de fichiers du fournisseur, et le workspace n'est pas
une frontière de sécurité du système de fichiers.

Un instantané CCR partagé garantit que les unités de contexte ont été observées
de manière cohérente. Il ne garantit **pas** un même état Git.

Et CCR peut établir quel contexte canonique il a fourni. Il ne peut pas établir
ce à quoi le modèle a intérieurement prêté attention. Auditer l'entrée n'est pas
auditer la lecture.

### Ce que cet acte est, et ce qu'il n'est pas

Il existe un fort parallèle structurel entre la discipline que CCR applique à son
propre chemin assisté et celle qu'il a développée pour tout le reste. Ce
parallèle est réel, et c'est ce qui en fait un mouvement de clôture défendable.

Ce n'est pas une auto-description que CCR aurait donnée à l'époque, et ce n'est
pas la destination que la conception la plus ancienne visait. L'affirmation selon
laquelle le commencement aurait consciemment planifié la fin n'est pas une
affirmation que cette histoire porte.

---

## Le motif visible rétrospectivement

Les cinq actes étant en vue, un motif qui les traverse peut être nommé.

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

Les actes ci-dessus en fournissent les occurrences. L'accord — un fait réel sur
ce que les relecteurs ont dit — promu en preuve. Un engagement réellement pris
par CCR, promu en exécution fournisseur qu'il n'a jamais observée. Une valeur
correctement détenue, promue par une surface en un sens métier que personne n'a
établi. Un champ d'origine renseigné, promu en origine légitime. Une orientation
déclarée, promue en valeur probante. Une réponse humaine enregistrée, promue en
acte faisant autorité. Un contexte disponible, promu en mandat. Un ordre, promu
en autorité de succession.

Dans ces cas, le point de départ est légitime. C'est ce qui rend la promotion
difficile à saisir : il n'y a aucune entrée fausse à détecter, et aucune étape
manifestement erronée. Le défaut réside dans la force de la conclusion,
relativement à l'autorité réellement détenue.

Deux choses doivent être dites de ce motif.

**Ce n'est pas une treizième fondation.** Il décrit ce que les douze ont en
commun ; ce n'est pas une treizième frontière à côté d'elles, et le traiter comme
telle reviendrait à compter double chaque occurrence.

**CCR n'a pas été conçu à partir de lui.** Le motif est quelque chose que l'on
remarque en parcourant les fondations, non une théorie unique dont elles auraient
été déduites. Chacune tient sur le problème précis qu'elle traite.

Tous les épisodes de cette histoire n'entrent pas dans ce motif, et aucun n'a été
remodelé pour y entrer.

---

## Ce que la maturité a fini par signifier

Aux côtés du motif court une trajectoire plus facile à énoncer qu'à remarquer
tant qu'elle se déroule.

Au fil de son développement, CCR a acquis **davantage** de machinerie
représentationnelle, non moins : structure de controverse, matériau et adduction,
actes de réconciliation à effets typés, sémantique temporelle à dimensions
indépendantes, read models dérivés, propositions assistées gouvernées. Ce qui a
changé en parallèle, c'est ce que chacune de ces constructions est autorisée à
affirmer.

C'est ce que consigne la formulation de maturité :

```text
CCR MATURITY
= MORE CAPABILITY
+ MORE OBSERVABILITY
+ FEWER UNAUTHORIZED INFERENCES
```

`FEWER UNAUTHORIZED INFERENCES` ne signifie pas que CCR raisonne moins, dérive
moins ou minimise ses puissances. Cela signifie que CCR structure et dérive
davantage, tout en devenant plus strict sur ce que chaque dérivation est
autorisée à signifier.

C'est une **manière rétrospective de comprendre le développement**. Ce n'est ni
un slogan fondateur, ni une feuille de route, ni un objectif de conception
d'origine, et cette histoire ne le raconte pas comme tel.

La formulation à retenir est que CCR ne se contente pas de minimiser sa
puissance. Il spécialise ses puissances.

---

## Rapport aux fondations, à la doctrine et aux spécifications

CCR se décrit selon quatre registres, et il vaut la peine d'être explicite sur
celui dont il s'agit ici.

**Design History** — le présent document — explique *pourquoi CCR est devenu
ceci*. C'est une explication rétrospective, et elle n'engage rien.

**Design Foundations** expose *les principes de conception dont CCR part*, avec
la définition conceptuelle de chaque distinction. Là où cette histoire nomme une
fondation au passage, c'est dans ce document qu'elle est réellement définie.

**La doctrine** énonce *ce que CCR affirme et refuse d'affirmer*.

**Les spécifications** énoncent *ce que les contrats courants de CCR
garantissent*.

Là où cette histoire et la doctrine ou les spécifications courantes sembleraient
diverger, ce sont la doctrine et les spécifications qui gouvernent le CCR
courant. L'histoire est un contexte, jamais une autorité sur le comportement
présent.

---

## Ce que cette histoire ne prétend pas

**Elle n'est pas exhaustive.** Les épisodes figurent ici parce qu'ils expliquent
un point de bascule, non parce que le développement serait couvert. Une grande
part de ce qui s'est passé entre les points de bascule est absente par choix.

**Les cinq actes ne sont ni le seul découpage possible ni un découpage
nécessaire.** Ils sont une organisation rétrospective, et CCR n'a jamais nommé de
programme en cinq actes. Aucune partie de ce récit ne doit être prise pour la
preuve que le développement aurait été structuré ainsi à l'époque.

**Ce n'est pas une histoire de dépôt.** C'est une histoire intellectuelle de la
conception. Elle ne reconstitue aucune séquence de publication, et ne doit pas se
lire comme un relevé de ce qui a été publié et quand.

**Ce ne sont pas les fondations.** Un lecteur qui veut savoir précisément ce que
signifie une fondation doit lire Design Foundations ; le présent document les
référence et ne les définit pas.

**Ce n'est ni de la doctrine ni un contrat.** C'est le moins contraignant des
registres de CCR, et le seul qui ait le droit d'être un récit.

Son but est de rendre la trajectoire lisible sans la faire paraître inévitable.
