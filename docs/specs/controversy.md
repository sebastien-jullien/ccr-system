# CCR — Spécification · Controverse

```text
STATUT   contrat courant
PORTÉE   contrat métier · local à un run
```

Ce document définit ce qu'est une **controverse** dans CCR : comment un désaccord
est ancré, persisté, projeté et gouverné.

Il décrit le **contrat courant**, avec la précision nécessaire pour contribuer.
Il ne remplace pas la doctrine : pour ce que CCR affirme et refuse d'affirmer,
voir [`../doctrine.md`](../doctrine.md).

---

# 1. Mission

Ce domaine répond à une question posée par la doctrine :

> **Que doit savoir CCR d'un désaccord sans devenir le juge de ce désaccord ?**

La réponse tient dans une capacité bornée : CCR sait **voir, consigner et
suivre** la structure d'un désaccord, sans détenir le droit d'en décider
l'issue.

Trois verbes, et pas un quatrième :

```text
VOIR       enregistrer qu'un désaccord est suivi, et sur quoi il porte
CONSIGNER  conserver qui a dit quoi, avec quelle autorité
SUIVRE     préserver l'histoire de ce qui a été affirmé, retiré, arbitré
```

```text
jamais     décider · trancher · classer d'office · convertir en vérité
```

---

# 2. Non-objectifs

Le domaine de la controverse ne contient rien de ce qui suit :

```text
matériaux et adductions           réconciliation
orchestration trans-run           controverse trans-run
graphe global de controverses     base de graphe · vector store · RAG
scoring · score de confiance      seuil de promotion
LLM judge · consensus engine      désignation d'un gagnant
```

Les deux premières lignes désignent des domaines voisins, tenus par leurs
propres contrats : [`evidence.md`](evidence.md) et
[`reconciliation.md`](reconciliation.md). Les suivantes ne relèvent d'aucun
contrat CCR et n'en relèveront pas : elles convertiraient une représentation en
verdict.

Ce contrat ne redéfinit ni le protocole de transfert, ni la sémantique de
reprise, ni le modèle d'usage. Il les consomme.

---

# 3. Invariants doctrinaux applicables

Les invariants de la doctrine qui contraignent directement la conception
ci-dessous :

| # | Invariant | Conséquence dans ce domaine |
|---|---|---|
| 1 | autorité normative humaine finale | aucune clôture n'est calculée |
| 4 | `Finding ≠ Remediation` | aucun constat ne produit d'action |
| 5 | présentation ≠ autorité métier | le cockpit ne décide pas qu'il y a désaccord |
| 7 | `unknown ≠ zero` | zéro controverse enregistrée ≠ zéro désaccord |
| 10 | classes de preuve non confondues | une inférence ne devient jamais une observation |
| 11 | ordre serveur autoritaire | aucune chronologie n'est reconstruite |
| 12 | pas d'autonomie avant compteur et frein | toute détection modèle est gouvernée |
| 13 | pas de réécriture rétroactive | l'histoire d'une controverse est append-only |

`CONVERGED` reste réservé. Le présent contrat ne lui donne **aucun** sens et
n'emploie le terme nulle part comme valeur.

---

# 4. Ce que la provenance native établit déjà

Le chemin d'exécution natif porte, sans ce contrat et indépendamment de lui :

```text
CCR demande la contradiction      elle est explicitement sollicitée
CCR la transmet fidèlement        ni résumé, ni reformulation
CCR la conserve intégralement     le contenu d'expert n'est jamais résumé
CCR ne l'observe pas              aucun type d'événement ne déclare un désaccord
```

La provenance des **acteurs** est complète et autoritaire : `expert_slot_id`,
`round`, `event_id`, `session_id`, ordre serveur. La provenance des **relations**
entre contributions, elle, n'est portée par aucun de ces champs : `based_on`
n'exprime qu'une causation opérationnelle, jamais une relation intellectuelle.

C'est exactement cet écart que le présent contrat couvre — et lui seul.

Une décision de run n'est par ailleurs enregistrable par aucun chemin natif :
`decisions.jsonl` n'a ni écrivain ni lecteur natif
([native-run-snapshot.ts](../../src/store/native-run-snapshot.ts)). Ce contrat
n'y touche pas ; il enregistre l'autorité humaine de son propre domaine, dans
son propre journal (§12).

---

# 5. Modèle d'autorité et de provenance

C'est la pièce centrale du contrat. Tout le reste s'y adosse.

## 5.1 Origine sémantique — catégorie et acteur

Une catégorie seule ne dit pas **de qui** vient la
sémantique. Tout fait V3 porte donc une origine composée :

```text
semantic_origin {
  kind        SOURCE | HUMAN | CCR
  actor       identité de l'attribué, selon ce que kind permet réellement
  about_actor présent seulement si kind = HUMAN et que la sémantique
              porte sur une source identifiée
}
recorded_by   HUMAN | CCR — qui a demandé l'écriture
```

Ce que `actor` contient, par catégorie :

| `kind` | `actor` | Justification |
|---|---|---|
| `SOURCE` | `expert_slot_id` | la doctrine : provenance métier canonique, jamais dérivée du fournisseur ni de `session_id` |
| `HUMAN` | **absent** | aucune identité humaine durable n'existe dans CCR — `author: 'human'` ([run.ts](../../src/core/run.ts)) et `actor: 'human'` sont des **littéraux de catégorie**, jamais des identités |
| `CCR` | le mécanisme, porté par `derivation` | §5.4 |

Aucune identité humaine n'est fabriquée. Pour `HUMAN`, le
contrat affirme exactement ce que l'architecture sait : qu'un humain est
l'auteur, et rien de plus.

**Un ancrage ne sert jamais d'identité de l'attribué.**
Les ancrages disent où porte l'entrée ; `semantic_origin.actor` dit de qui vient
sa sémantique. Une entrée `SOURCE` ancrée sur une contribution de l'Auteur mais
attribuée au Challenger doit rester lisible comme telle, donc distinguable.

## 5.2 Sémantique humaine *à propos* d'une source

Un humain qui lit un passage et écrit « Challenger affirme
X » produit une **structuration sémantique qui est la sienne** : le choix de ce
qui compte comme l'assertion, sa formulation, sa portée.

```text
kind        HUMAN
about_actor challenger
```

Un ancrage textuel rend cette transcription
**auditable** : quiconque peut lire l'original et juger. Il ne la rend pas
**source-authored**. Vérifiabilité textuelle et fidélité sémantique sont deux
propriétés différentes, et seule la première est acquise.

```text
auditable  ≠  source-authored
```

La règle courante :

```text
HUMAN STRUCTURED TRANSCRIPTION IS ALLOWED,
BUT REMAINS HUMAN-ATTRIBUTED ABOUT THE SOURCE
```

La transcription humaine structurée est donc **admise**, sous `kind = HUMAN` avec `about_actor`, et avec un `TextualAnchor`
**obligatoire** vers le passage lu. L'ancrage est ce qui la rend auditable ; sans
lui, l'attribution ne serait vérifiable par personne.

`AUDITABLE ≠ SOURCE-AUTHORED`.

## 5.2bis Productibilité de `kind = SOURCE`

Il faut le dire sans détour : **aucune entrée structurée dont l'origine
sémantique soit `SOURCE` n'est productible.**

```text
kind = SOURCE   réservé à une sémantique EFFECTIVEMENT produite par la source
```

Aucun mécanisme n'existe : CCR ne peut pas reconnaître de façon
déterministe qu'un expert a déclaré quelque chose (§14), et une transcription
humaine relève de `HUMAN` par définition (§5.2).

Le protocole expert **n'est pas modifié** par ce contrat. Un protocole
structuré permettant à une source de produire elle-même une assertion n'existe
pas, et exigerait son propre contrat.

La catégorie `SOURCE` est donc **définie mais non productible**, et le contrat
ne fabrique aucun producteur pour la remplir. Elle demeure parce qu'elle nomme correctement ce qu'un protocole futur
produirait, et parce que l'effacer obligerait à la réintroduire.

Conséquences, énoncées comme telles :

```text
SOURCE CONTENT       ≠  HUMAN INTERPRETATION OF SOURCE
HUMAN TRANSCRIPTION  ≠  SOURCE ASSERTION
CCR DERIVATION       ≠  HUMAN TRANSCRIPTION
```

## 5.3 Ce que l'origine sémantique n'est pas

Les sept classes de preuve de la doctrine — `REAL_NOW`,
`HISTORICAL_REAL_FROZEN`, `AUTOMATED_REAL_PROCESS`, `FIXTURE`, `STATIC`,
`MONITORED`, `NOT_TESTED` — qualifient **la validation d'une implémentation
CCR**. Elles ne qualifient pas l'autorité sémantique d'un fait de controverse.

Les deux vocabulaires ne se croisent nulle part. Aucune
structure V3 ne porte un champ nommé `evidence`, et aucune classe de preuve
n'apparaît dans une donnée V3 persistée.

Motif : `evidence` porte déjà deux sens autoritaires dans CCR — les sept classes,
et le statut Recovery `EVIDENCE_CONFLICT` affiché « faits contradictoires »
([labels.js](../../src/cockpit/web/labels.js)). Un troisième sens rendrait le
terme inutilisable.

## 5.4 Dérivation

Tout fait `kind = CCR` porte un bloc `derivation` :

```text
derivation {
  method         DETERMINISTIC_LOCAL | MODEL_ASSISTED
  invocation_id  REQUIS si MODEL_ASSISTED · ABSENT sinon
  inputs[]       références stables vers les éléments utilisés
}
```

`method` est une **union fermée à deux valeurs**. Toute valeur supplémentaire serait une extension contractuelle explicite.

Le fournisseur et le modèle ne sont **pas** dupliqués : ils
se retrouvent par `invocation_id` dans l'`InvocationLedger`, qui en est
l'autorité.

Aucun horodatage de dérivation. L'ordre autoritaire vient
de l'append du journal V3 (§10) ; un troisième repère temporel n'ajouterait
qu'une chronologie concurrente.

Aucun score de confiance n'est défini. Le contrat et la doctrine
interdisent qu'un seuil fasse une vérité ; un tel champ n'aurait aucun usage
légitime, et son existence inviterait à l'usage illégitime.

---

# 6. Modèle Controversy

## 6.1 Décision structurante

**Une controverse n'est pas un objet à états. C'est une
identité, plus une suite append-only d'entrées attribuées.**

```text
Controversy = identity
            + ordered, append-only sequence of attributed entries
```

**Il n'existe aucun champ de statut**, et **aucune
projection agrégée d'état**. Ni `OPEN`, ni `CLOSED`, ni `RESOLVED`, ni
`INACTIVE`, ni `PARTIAL`, ni `CONVERGED`.

## 6.2 Pourquoi aucun statut

Il est interdit que le silence, l'absence d'activité ou une
inférence de compatibilité fassent évoluer une controverse. Deux façons de
respecter cet interdit :

```text
par contrôle       un champ status existe, et des règles interdisent
                   certaines transitions

par construction   aucun champ status n'existe, donc aucune transition
                   n'est représentable
```

Le second est plus fort. Tant qu'un champ de statut existe, une implémentation,
une projection ou un correctif peut l'écrire ; l'interdit dépendrait d'une
vigilance permanente.

C'est le raisonnement qui a déjà fait de la clé d'un slot d'expert son rôle
plutôt que d'y ajouter un contrôle : supprimer une faute par construction plutôt
que par contrôle.

La même règle s'applique à la lecture : le read model
n'agrège aucune disposition. Il expose des **faits de registre** (§18).

## 6.3 Identité

```text
controversy_id   identifiant opaque, stable, unique dans le run
run_id           le run propriétaire
recorded_at      horodatage de l'entrée d'enregistrement
```

L'identité est **épistémiquement neutre**. Elle atteste
qu'un enregistrement existe, jamais qu'un désaccord est établi. Créer une
identité ne prouve rien du fond.

La portée est **run-local**. Aucun
`global_controversy_id`, `cross_run_id`, `mission_id` ni `stream_id` n'est créé.

La forme de `controversy_id` suit les conventions du dépôt ;
le contrat n'en fige que les propriétés : opaque, stable, unique dans le run,
jamais réutilisé.

---

# 7. Modèle d'ancrage

Ancrage multi-niveaux : provenance et niveau
d'interprétation explicitement distingués.

## 7.1 Trois familles

Trois familles, une seule obligatoire.

### ProvenanceAnchor — obligatoire

```text
event_id          l'événement ancré — déjà adressable
expert_slot_id?   le slot, lorsque l'événement en relève
round             le tour, recopié depuis l'événement
session_id?       la continuité native, lorsqu'elle s'applique
```

**Toute entrée V3 porte au moins un `ProvenanceAnchor`.**
Une controverse sans lien vers une production réelle n'aurait aucune racine
vérifiable.

### TextualAnchor — facultatif, au plus un par entrée

```text
event_id      l'événement dont le contenu est cité
quoted_text   le fragment exact — COPIE DE VÉRIFICATION
occurrence    rang de l'occurrence exacte dans le contenu, à partir de 1
```

Aucun décalage numérique n'est stocké. Ni octet, ni point
de code, ni unité UTF-16.

Motif : le contenu est une
chaîne JS de la capture au rendu ([process-runner.ts](../../src/process/process-runner.ts)),
et le fichier contient les octets du **JSON échappé**, non ceux du contenu
([atomic-file.ts](../../src/store/atomic-file.ts)). La séquence d'octets UTF-8
du contenu n'existe à aucune étape du chemin. Un décalage en octets désignerait
une représentation que rien ne détient.

La citation est en outre le seul candidat
**auto-vérifiant** : un décalage erroné désigne un fragment plausible sans que
rien ne le signale ; une citation se confronte à l'original.

### SemanticAnchor — facultatif, **au plus un par entrée**

```text
text            l'énoncé de l'unité — proposition, thème, question
semantic_origin origine propre à cet énoncé
```

Tout ancrage sémantique conserve la provenance de sa
sémantique. Son `semantic_origin` est **indépendant** de celui de l'entrée qui le
porte.

**Un ancrage sémantique ne porte aucune identité de
position.** Deux entrées citant le même énoncé ne sont pas reliées par ce fait.
La continuité s'exprime uniquement par des relations déclarées (§8).

La cardinalité maximale de un est une règle, non une
commodité : elle rend univoque toute entrée qui vise une autre entrée (§8.3).

## 7.2 Résolution et validation d'un ancrage textuel

```text
recherche       EXACTE sur la chaîne canonique — sous-chaîne, sans transformation
normalisation   AUCUNE : ni Unicode, ni fins de ligne
                le dépôt n'en applique aucune, à aucune étape
occurrence      rang 1-based des occurrences exactes, dans l'ordre du contenu
validation      à L'ÉCRITURE : l'occurrence demandée doit exister ;
                sinon l'écriture est refusée, avec un code public
autorité        le contenu canonique de l'événement fait foi, toujours
divergence      ANCHOR_UNRESOLVABLE — jamais un extrait vide, jamais un silence
```

Un ancrage non résolu est un `unknown`, pas un zéro. La projection le dit.

Le contenu étant immuable, une citation validée à
l'écriture reste retrouvable. La divergence ne peut donc venir que d'une
validation omise ou d'un événement devenu illisible — ce dernier cas relevant de
Recovery (§21), non de la controverse.

## 7.3 Ce que l'ancrage textuel ne fait pas

`TEXTUAL LOCATION ≠ SEMANTIC CLAIM`. Citer un
fragment ne l'interprète pas.

Aucune correspondance vers le DOM rendu n'est requise.

Le rendu Markdown construit le DOM par nœuds depuis un arbre de
jetons, sans conserver de table de correspondance
([markdown.js](../../src/cockpit/web/markdown.js)). Aucun repère dans la
source, quelle qu'en soit l'unité, n'y survit.

Le surlignage dans le Markdown rendu n'est requis par
aucun besoin d'information du contrat (§20). Un besoin d'interface non exprimé ne
doit pas dicter un format persisté.

## 7.4 Ce qui n'est jamais fait

```text
aucune mutation d'une contribution historique
aucune réécriture de contenu pour « normaliser » un ancrage
aucun ancrage vers un contenu que CCR aurait transformé
la citation stockée ne devient jamais une autorité concurrente
```

---

# 8. Assertions, relations, inférences

## 8.1 Pas d'objet `Position`

Ce contrat **ne crée pas** d'objet `Position`, et aucune entrée ne partage
d'identité de position avec une autre.

L'argument est celui de l'attribution, non celui de la
simplicité. Un identifiant de position partagé entre plusieurs entrées est une
**identité**, et une identité ne porte pas d'attribution : elle affirme que ces
assertions sont la même position sans dire **qui** l'a établi.

Or tout fait doit porter son attribution. Une identité partagée en est
structurellement incapable.

```text
identité partagée   « ce sont la même position »        non attribuable
relation déclarée   « X déclare que B reformule A »     attribuée par construction
```

C'est le même déplacement que celui opéré sur la controverse elle-même :
remplacer une entité muette par des faits attribués.

## 8.2 Une entrée d'assertion porte une seule unité sémantique

Une entrée d'assertion porte **au plus un** ancrage
sémantique (§7.1).

Sans cette règle, une entrée visant une autre entrée serait
ambiguë : viser une entrée à trois énoncés ne dirait pas lequel est visé. La
cardinalité résout le problème sans introduire d'identité.

## 8.3 La continuité est une relation, jamais une identité

Une entrée de relation relie deux entrées et déclare
l'**acte** qui les lie :

```text
from_entry_id     l'entrée qui agit
to_entry_id       l'entrée visée
act               CONTESTS | REFORMULATES | WITHDRAWS
semantic_origin   qui déclare cette relation
recorded_by       qui a demandé l'écriture
anchors[]         au moins un ProvenanceAnchor
```

Le noyau d'actes est **minimal et justifié un à un** :

| `act` | Pourquoi il est nécessaire |
|---|---|
| `CONTESTS` | sans lui, une controverse ne peut pas être représentée — deux entrées ancrées au même endroit seraient indiscernables |
| `REFORMULATES` | seule façon d'exprimer une continuité intellectuelle sans identité partagée |
| `WITHDRAWS` | cas d'autorité explicitement admissible |

Ce n'est **pas** une taxonomie. `SUPPORTS`, `QUALIFIES` et
tout autre acte sont absents parce qu'aucun besoin établi ne les exige, non
parce qu'ils seraient illégitimes. Toute extension devra se justifier de la même
façon.

Une relation n'est pas une nature de désaccord. Les natures
relèvent de leur propre entrée (§9).

## 8.4 Qui peut déclarer une relation

| Origine | Disponible ? |
|---|---|
| `SOURCE` — la source déclare elle-même | **non** — aucun protocole structuré ne l'alimente |
| `HUMAN` | oui |
| `CCR` | autorisé, avec `derivation` obligatoire |

Une inférence de similarité ne devient jamais une
identité non qualifiée. Le modèle le garantit par construction — la relation est
une entrée, et une entrée ne perd jamais son origine sémantique.

**L'absence de relation déclarée ne signifie rien.** Deux
assertions voisines restent deux assertions. C'est `unknown ≠ zero` appliqué à la
continuité.

Aucune relation n'est jamais créée parce que deux textes se
ressemblent. La similarité n'est pas une autorité.

## 8.5 L'acte est porté, jamais déduit de l'ancrage

Un ancrage ne suffit pas à distinguer une position d'une objection : il dit *où*
et *sur quoi*, jamais *ce que l'entrée fait*. Deux entrées ancrées au même
endroit — l'une appuyant, l'autre contestant — sont structurellement identiques
si rien ne porte l'acte.

L'acte est donc explicite, et il vit sur la relation.

## 8.6 L'interdit central

Aucune promotion implicite
`SYSTEM INFERENCE → SOURCE ASSERTION`.

Garanti par construction : `semantic_origin` est fixée à
l'écriture et **jamais modifiée**. Le journal étant append-only, aucun chemin ne
peut la réécrire.

Une réévaluation ultérieure ne modifie pas l'entrée d'origine : elle **ajoute**
une entrée qui s'y réfère. L'inférence initiale reste visible avec son origine
initiale.

---

# 9. Qualification de nature — facultative

Qualification facultative et attribuée.

La nature n'est **pas** un champ de la controverse. C'est
une entrée comme les autres, `NATURE_RECORDED`, portant :

```text
nature           texte libre borné
semantic_origin  { kind, actor?, about_actor? }
```

**Aucune énumération n'est définie.** Ni `FACTUAL`, ni
`NORMATIVE`, ni `INTERPRETIVE`, ni liste initiale « minimale ».

Motif, et c'est une décision assumée : le contrat interdit une taxonomie
définitive mais autorise des valeurs initiales « minimales, justifiées,
extensibles, non exhaustives ». Le contrat estime qu'aucune valeur initiale n'est
justifiable aujourd'hui — aucun run réel ne porte de qualification, donc aucune
liste ne serait fondée sur autre chose qu'une intuition. Une liste posée sans
fondement deviendrait une taxonomie de fait dès la première interface qui
l'affiche en menu déroulant.

La doctrine impose de ne pas confondre fait, interprétation
et norme. Le contrat préserve cette distinction en **rendant l'absence
représentable** : une controverse sans qualification est le cas normal, pas un
cas dégradé. La règle est générale dans CCR : un schéma qui ne sait pas exprimer
l'abstention force le mensonge.

Plusieurs qualifications, d'attributions différentes, peuvent coexister sans se
contredire : elles disent qui pense quoi, pas ce qui est vrai.

---

# 10. Modèle temporel

Le journal de controverses est **append-only**. Une
correction crée une entrée nouvelle ; elle ne réécrit jamais l'ancienne.

C'est la règle d'écriture de CCR, sans exception connue.

## 10.1 Un seul ordre autoritaire

```text
entry_id      séquence d'append strictement croissante dans le run
              → ORDRE AUTORITAIRE du journal V3, et le seul

recorded_at   information temporelle
              → JAMAIS une clé de tri autoritaire
```

**Aucun troisième repère temporel n'existe.** Un
horodatage de production sur les dérivations a été retiré : il dupliquait une
information que l'`InvocationLedger` détient déjà pour `MODEL_ASSISTED`, et
créait une chronologie concurrente pour un gain nul.

La règle est simple à vérifier : une lecture qui trie par
horodatage viole le contrat, quelle que soit sa raison.

## 10.2 Ce qui doit survivre

```text
ce qu'un expert avait affirmé
qu'une inférence avait été produite, et par quel mécanisme
qu'un humain avait enregistré une autorité, et dans quel périmètre
qu'une relation avait été déclarée, et par qui
```

Une projection courante n'est jamais une réécriture historique.

---

# 11. Autorité et clôture

Une controverse n'évolue que par un événement
explicite d'autorité suffisante **relativement à ce qui est concerné**.

## 11.1 Aucune disposition agrégée

Le contrat **n'expose aucune disposition calculée**.

Une valeur telle qu'« autorité partielle » supposerait d'établir qu'une autorité
*ne couvre pas tout ce qui est ancré*. L'établir exigerait de comparer un
périmètre énoncé en texte libre aux ancrages : **une lecture du fond, donc une
inférence non attribuée**, précisément ce que le contrat interdit. Le contrat
renonce donc à la projection plutôt que d'inférer.

Ce que la lecture expose est purement factuel (§18) :

```text
les entrées d'autorité enregistrées
leurs cibles structurées
leur origine sémantique
leur ordre dans le journal V3
```

Un seul fait d'absence est admissible, et il est de pur
registre :

```text
no_authority_entry_recorded   aucune entrée d'autorité n'existe
                              → un fait sur le journal, jamais un état
```

Aucune valeur ne dit qu'un désaccord
est ouvert, résolu, actif ou inactif. Ces mots n'existent nulle part dans le
contrat.

## 11.2 Le silence ne produit rien

Il n'existe aucune règle temporelle, aucun délai, aucune
transition par inactivité. Structurellement : **aucune entrée n'est écrite par le
passage du temps**, et rien n'est agrégé, donc rien ne peut changer sans qu'un
acteur agisse.

## 11.3 Ce qu'aucune entrée ne signifie

Pour chaque forme d'autorité, ce qu'elle **ne** dit
**pas** :

| Fait | Autorité | Effet | Ce qu'il ne signifie pas |
|---|---|---|---|
| relation `WITHDRAWS`, déclarée par l'auteur de l'assertion visée | l'auteur, sur sa seule assertion | l'assertion visée n'est plus soutenue par son auteur | l'autre position est vraie · consensus · controverse close · remédiation acceptée · décision normative |
| `HUMAN_AUTHORITY_RECORDED` | l'humain, dans le périmètre qu'il énonce | une autorité normative est enregistrée pour ce périmètre | que les experts se sont accordés · que l'histoire est réécrite · que ce qui est hors périmètre est tranché |

`HUMAN DECISION ≠ EXPERT AGREEMENT`. Une autorité humaine
ne réécrit jamais l'histoire des experts, et la projection ne la présente jamais
comme un accord.

Directement : une autorité humaine n'a d'effet que
**dans son périmètre explicite**. Hors périmètre, aucun effet d'autorité. Le
contrat n'a rien à calculer pour honorer cette règle — il lui suffit de ne rien
agréger.

## 11.4 `CONVERGED`

Réservé. Le contrat ne lui donne aucun sens et ne
l'emploie comme valeur nulle part. N'agrégeant aucun état, il n'en a aucun usage.

---

# 12. Intervention humaine — et la lacune native

Aucun chemin natif n'enregistre de décision de run humaine.

Ce contrat **n'a pas besoin** de réveiller le modèle d'une génération
antérieure. Ce dont il a besoin est plus étroit et vit dans son propre journal :

```text
HUMAN_AUTHORITY_RECORDED
  semantic_origin  kind = HUMAN
  scope            énoncé du périmètre arbitré, texte libre borné
  content          la décision elle-même
  anchors[]        ce qu'elle vise, structurellement
```

Portée strictement bornée au domaine de la controverse :

```text
elle porte sur une controverse identifiée et ses cibles structurées

elle ne constitue PAS
  une décision générale de run
  une décision produit globale
  une future décision native universelle
```

Ce contrat n'enregistre que l'autorité nécessaire à son propre domaine, et ne
prétend pas combler la lacune générale. Si un modèle général de décision native
était introduit, il lui reviendrait de définir son articulation avec le présent
journal et la règle de non-duplication ; aucune des deux n'est présumée ici.

**Ce qui doit être enregistré** est une autorité normative humaine **portant sur
une controverse identifiée**. Cela n'a
pas la même portée qu'une décision de run, qui est ce que `decisions.jsonl`
portait côté legacy.

`decisions.jsonl` n'est **pas** sélectionné, ni réveillé,
ni étendu. La décision de run native reste une lacune connue, hors périmètre de
ce contrat, qui ne prétend pas la combler.

L'autorité vaut **dans le périmètre énoncé**, et
hors de lui il n'y a pas d'effet d'autorité. Le contrat n'a rien à calculer pour
l'honorer — il lui suffit de ne rien agréger (§11.1).

---

# 13. Détection assistée par modèle

`ALLOWED · OPTIONAL · GOVERNED`.

## 13.1 Capacité et politique

```text
MODEL_DETECTION_ALLOWED  = YES
MODEL_DETECTION_REQUIRED = NO
```

**La détection s'exécute sur action humaine explicite, et uniquement ainsi.**
Aucun déclenchement automatique, à aucun tour, par aucune lecture.

La doctrine pose qu'il n'y a *pas d'autonomie avant le compteur et le frein*.
Le compteur et le frein existent — quota d'admission et ledger d'invocation —
ce qui rend l'autonomie *admissible*. Rien ne la rend *nécessaire* : en
l'absence de raison forte, le contrat retient le mécanisme le moins autonome.
Une politique plus automatique resterait ajoutable sans changer le modèle de
données ; l'inverse — retirer une automatisation déjà consommée par des runs
réels — serait bien plus coûteux.

Une politique plus automatique reste ajoutable plus tard sans
changer le modèle de données : elle ne changerait que **qui** déclenche.
L'inverse — retirer une automatisation déjà consommée par des runs réels — serait
bien plus coûteux.

## 13.2 Ce que produit une détection

Une détection réussie produit une ou plusieurs entrées
`CONTROVERSY_RECORDED` portant `semantic_origin.kind = CCR` et une `derivation`
avec `method = MODEL_ASSISTED` et son `invocation_id`.

Elle ne devient jamais automatiquement une assertion
d'expert, une assertion humaine, un fait non qualifié, une clôture.

## 13.3 Gouvernance

Tout appel fournisseur orchestré par
CCR passe par les primitives de gouvernance d'usage.

La détection consomme la chaîne existante, sans en créer une
seconde :

```text
décision métier définitive
→ contrôle de politique / quota
→ allocation invocation_id
→ écriture durable DISPATCH_COMMITTED
→ appel fournisseur
```

## 13.4 Déclencheur d'invocation et version de ledger

La détection de controverse possède **son propre déclencheur**, et n'en réemploie
aucun autre :

```text
CONTROVERSY_DETECTION   →  version de ledger ÉCRITE : 2
```

Réutiliser un déclencheur existant avec un faux sens serait un mensonge de
ledger : le journal dirait pourquoi une invocation a été engagée, et se
tromperait.

Le ledger d'invocations porte une version **par enregistrement**, jamais par
fichier ([usage-governance.ts](../../src/core/usage-governance.ts)). La version
suit la **charge**, jamais le millésime du runtime : un `SEND` écrit après une
détection reste en version 1.

Le vocabulaire courant, admis en lecture, couvre **les versions 1 à 4** — chaque
version ajoutant son propre déclencheur sans jamais élargir rétroactivement une
version antérieure. Les versions 3 et 4 appartiennent aux domaines des matériaux
et de la réconciliation ; le présent contrat ne les définit pas, ne les possède
pas, et n'en dépend pas.

```text
version écrite = 2 pour ce domaine, et cela ne bougera pas
version courante MAXIMALE du ledger ≠ version écrite par ce domaine
```

Trois garanties, valables quelle que soit l'extension future :

```text
lecteur antérieur   rencontre une VERSION qu'il déclare non supportée et
                    refuse explicitement, au lieu d'échouer sur une valeur
                    d'énumération inconnue — un refus lisible, ligne par ligne

version inconnue    refus explicite de cet enregistrement, jamais un saut
déclencheur inconnu  refus explicite, jamais un sens inventé

repli               AUCUN repli silencieux vers un déclencheur existant
```

Aucun enregistrement historique n'est réécrit, requalifié ni migré. Un
déclencheur ajouté plus tard, à une version plus haute, ne change rien à la
sémantique de la controverse.

**La gouvernance d'usage n'est pas modifiée par ce contrat.** Elle est
consommée telle quelle.

## 13.5 Disponibilité au démarrage

Trois faits restent **indépendants**, et aucun raisonnement ne doit les fondre :

```text
capacité implémentée        le code existe
disponibilité au runtime    ce qu'un humain est autorisé à déclencher
validation fournisseur      ce qui a été réellement observé
```

« Implémenté » n'implique pas « disponible ». « Éprouvé avec un adaptateur de
test » n'implique pas « validé en réel ».

La disponibilité au runtime est une **constante de code**, jamais un fichier de
validation, une préférence ni un drapeau mutable. Sa levée exige :

```text
au moins une détection exécutée contre une CLI fournisseur réelle
l'invocation présente au ledger, avec son issue
le comportement d'échec observé au moins une fois
la classe de preuve rapportée REAL_NOW, avec sa sortie citée
```

**État courant : la détection assistée par modèle est disponible**
([controversy-detector.ts](../../src/services/controversy-detector.ts)). Cela
dit exactement une chose — un humain **peut** demander une détection. Jamais
qu'une détection se lance d'elle-même.

L'effet d'invocation d'une détection est déclaré comme les
autres opérations, via la primitive partagée `operationEffect`, et non codé en
dur côté frontend.

## 13.6 Ce que la détection ne fait jamais

```text
elle ne clôt rien
elle ne qualifie pas d'office une nature
elle ne modifie aucune entrée existante
elle ne produit aucun score
elle ne s'exécute pas sans qu'un humain l'ait demandée
```

---

# 14. Faits déterministes locaux

Trois niveaux :

```text
N1  « Challenger a produit tel texte »        établi, et déjà autoritaire
N2  « Challenger conteste telle proposition » non établissable
N3  « A et B sont en désaccord sur X »        non établissable
```

Le déterministe local porte :

```text
la provenance des ancrages          event_id · slot · round · session
la validation des ancrages textuels bornes, frontières UTF-8, résolution
l'unicité et l'ordre des entrées
la détection de doublons exacts
```

**Aucun mécanisme de reconnaissance de tournures n'est
défini, ni maintenant ni comme extension prévue.** Une occurrence syntaxique
n'établit pas sa sémantique, et le dépôt documente une cause concrète de faux
positif : un agent peut recopier verbatim l'enveloppe reçue dans sa propre
réponse ([transfer.ts](../../src/services/transfer.ts)), de sorte que le
contenu d'une réponse peut contenir le texte de l'autre expert.

Aucune expression régulière ne devient une autorité sémantique.

---

# 15. Persistance

## 15.1 Emplacement

Un journal dédié, run-local, append-only :

```text
<run>/controversies.jsonl
```

Le journal est **dédié**, et trois voisinages sont exclus par règle :

```text
events.jsonl        REFUSÉ — mêle deux domaines, et son type d'événement est
                    partagé avec la génération historique : l'ajout rendrait
                    ces types admissibles dans un journal historique
decisions.jsonl     REFUSÉ — journal d'une autre génération, sémantique
                    différente
base externe        REFUSÉ — hors périmètre ; le domaine est run-local
```

Une projection sans persistance ne conviendrait pas davantage : un état
persistant est requis.

## 15.2 Un seul point d'écriture durable

**Aucun événement n'est écrit dans `events.jsonl` pour une activité de
controverse.**

Même motif que l'engagement durable d'une invocation : deux écritures dans deux
fichiers ne sont pas atomiques. Si l'une aboutit et l'autre non, le
système ment. Un point d'écriture durable unique supprime la question.

Conséquence assumée : **un lecteur de `events.jsonl` seul
ne verra aucune activité de controverse.** Cohérent avec la frontière déjà tracée
pour `rounds/` et `artifacts/`.

## 15.3 Le journal appartient à la lecture stable

Le snapshot natif applique un protocole observe → lire → réobserver sur
l'ensemble des sources canoniques du run
([native-run-snapshot.ts](../../src/store/native-run-snapshot.ts)). Si une
source bouge pendant la lecture, il lève `SNAPSHOT_UNSTABLE` plutôt que de rendre
une combinaison qui n'a peut-être jamais coexisté.

**`controversies.jsonl` appartient à cette frontière.** Le journal n'est pas lu
à côté du snapshot : il en fait partie.

```text
GARANTIE CONTRACTUELLE

  un snapshot combinant l'état du run et le journal des controverses
  n'est JAMAIS rendu si ces observations n'ont pas été constatées
  coexistantes selon le protocole observe → read → re-observe
```

Sans cette appartenance, une lecture combinée pourrait rendre un état de run et
un journal de controverses qui n'ont jamais coexisté : exactement la vue que le
protocole existe pour interdire. Le verrou protège l'écriture ; il ne protège
pas la lecture.

Absence de la source sur un run natif antérieur à V3 :

```text
fichier absent   →  ABSENCE STABLE ET HONNÊTE
                    une absence observée est une observation ; elle participe
                    au protocole de stabilité comme les autres
                    JAMAIS une corruption, jamais un échec de lecture
```

Les mutations conservent le **verrou de run existant**,
inchangé : un seul écrivain par run (la doctrine). Aucun verrou nouveau.

## 15.4 Révisions

Le journal des controverses est une **source persistée autoritaire**. Il ne se
raisonne pas comme une projection non persistée dérivée d'un état déjà capturé :
les deux ne posent pas le même problème de fraîcheur, et aucune analogie entre
elles ne tient.

```text
revision              INCHANGÉE — manifest · state · events
                      sémantique gelée, algorithme intact

controversy_revision  empreinte du journal V3
                      CAPTURÉE DANS LE MÊME SNAPSHOT STABLE
```

**Un seul modèle de concurrence optimiste**, appliqué à deux
portées :

```text
mutation de run          jeton de fraîcheur = revision
mutation de controverse  jeton de fraîcheur = controversy_revision
```

Les deux portées sont légitimement indépendantes : ajouter une
entrée de controverse ne change pas l'état opérationnel du run, et un tour
d'expert ne périme pas une controverse. Exiger le jeton de run pour une mutation
de controverse ferait échouer des écritures parfaitement valides.

Parce que les deux révisions proviennent du **même snapshot
stable**, une réponse qui les porte toutes deux atteste qu'elles **ont coexisté**.
C'est cette garantie, et non leur nombre, qui rend la combinaison honnête.

La sémantique de `revision` n'est modifiée en rien.

## 15.5 Écriture, ligne partielle, reprise

Garanties, sans prescrire d'implémentation :

```text
append          une entrée est écrite comme une ligne JSON complète terminée
                par un saut de ligne
ligne partielle un fragment final non terminé est un état TRANSITOIRE d'append,
                jamais une corruption
lecture         un tel fragment est ignoré comme non encore écrit ;
                aucune entrée partielle n'est jamais interprétée
corruption      une ligne TERMINÉE mais invalide est une corruption réelle :
                refus explicite, jamais une vue partielle silencieuse
version inconnue refus explicite — voir §24
```

Cette discipline existe déjà dans le dépôt : le lecteur JSONL
tolère un fragment final non terminé et ne le confond pas avec une corruption
([jsonl-journal.ts](../../src/store/jsonl-journal.ts)). Le contrat exige la même
garantie ; il ne recopie pas son implémentation.

**Aucune vue partielle fausse n'est jamais rendue.** Une
lecture qui ne peut pas établir un état cohérent échoue explicitement.

## 15.6 Absence de données V3

Un run sans `controversies.jsonl` est un run **normal**.
L'absence signifie exactement : aucune entrée n'a été écrite.

La lecture ne convertit jamais cette absence en « aucun désaccord ».

---

# 16. Modèle d'entrée

Une seule forme d'enregistrement, discriminée par `kind`.
**Cinq** types.

## 16.1 Forme commune

```text
schema_version    entier
entry_id          séquence d'append strictement croissante dans le run
controversy_id    la controverse visée
kind              le discriminant
semantic_origin   { kind, actor?, about_actor? }        §5.1
recorded_by       HUMAN | CCR
recorded_at       information temporelle, jamais clé de tri
round             tour du run à l'écriture
anchors[]         au moins un ProvenanceAnchor
                  au plus un TextualAnchor
                  au plus un SemanticAnchor
derivation?       REQUIS si semantic_origin.kind = CCR · INTERDIT sinon
content?          texte borné, selon le kind
```

## 16.2 Les cinq types

| `kind` | Ce que la charge prouve | Acteur | Idempotence | Ce qu'il n'implique pas |
|---|---|---|---|---|
| `CONTROVERSY_RECORDED` | un enregistrement de controverse existe, avec son motif et ses ancrages | humain, ou CCR après détection | même `controversy_id` refusé deux fois | qu'un désaccord est prouvé |
| `ASSERTION_RECORDED` | une assertion est rattachée, avec au plus une unité sémantique | humain, ou CCR | doublon exact refusé | que l'assertion est vraie |
| `RELATION_RECORDED` | une relation `CONTESTS` \| `REFORMULATES` \| `WITHDRAWS` est déclarée entre deux entrées | humain, ou CCR | doublon exact refusé — même triplet `from`/`to`/`act`/origine | que la relation est fondée |
| `NATURE_RECORDED` | une qualification de nature est proposée, avec son origine | humain, ou CCR | doublon exact refusé | qu'elle fait autorité sur le fond |
| `HUMAN_AUTHORITY_RECORDED` | une autorité humaine est enregistrée : soit un arbitrage avec son périmètre énoncé, soit un acte `CONFIRM_RELATION` \| `CONTEST_RELATION` sur une inférence visée | humain | non idempotent — deux autorités distinctes sont légitimes, y compris successives sur la même cible | accord des experts · vérité sur le fond |

## 16.3 Ce qui a été retiré, et pourquoi

```text
CONTROVERSY_OPENED   → CONTROVERSY_RECORDED
                       « opened » appartient à une paire dont l'autre moitié
                       est bannie ; le geste est un enregistrement, et son
                       nom le dit maintenant

POSITION_WITHDRAWN   → relation act = WITHDRAWS
                       le nom promettait un objet Position inexistant, et sa
                       cible était de toute façon une entrée

NATURE_QUALIFIED     → NATURE_RECORDED
                       cohérence : toutes les entrées enregistrent

INFERENCE_DISPUTED   → DIFFÉRÉ
                       voir §16.4
```

## 16.4 Réponse humaine à une inférence CCR

La règle courante :

```text
HUMAN CONFIRMATION / CONTESTATION OF A CCR INFERENCE
IS A NEW ATTRIBUTED AUTHORITY ENTRY
```

Mécanisme, et il est entier :

```text
l'inférence CCR originale   CCR · IMMUABLE · CONSERVÉE DANS L'HISTOIRE
toute réponse humaine        NOUVELLE entrée append-only
                             semantic_origin.kind = HUMAN
                             référence explicite à l'inférence visée
                             AUCUN changement de l'entrée d'origine
```

L'acte est porté par `HUMAN_AUTHORITY_RECORDED` (§16.2), et
deux valeurs **strictement symétriques** sont définies :

```text
CONFIRM_RELATION
CONTEST_RELATION
```

Aucun type d'entrée nouveau n'est créé : les deux actes vivent
dans la charge de l'entrée d'autorité humaine, qui porte déjà l'origine
sémantique, les ancrages et la référence. C'est un choix technique, non un
arbitrage — et il évite l'explosion des types.

### `CONFIRM_RELATION`

L'humain affirme que la relation de désaccord représentée par l'inférence peut
être tenue pour établie **dans la représentation CCR de la controverse**.

```text
CE QUE LA LECTURE PEUT AFFIRMER
  une confirmation humaine de cette relation est enregistrée

CE QU'ELLE NE PEUT PAS EN DÉDUIRE
  qu'une position est vraie          qu'une autre est fausse
  que les preuves sont suffisantes   qu'un expert a tort
  qu'un expert a raison              qu'il existe une convergence
  que la controverse est close       qu'une remédiation est choisie
```

`HUMAN CONFIRMATION ≠ TRUTH ON THE MERITS`.

### `CONTEST_RELATION`

L'humain affirme que cette inférence **ne doit pas être retenue** comme relation
humaine-confirmée de désaccord.

```text
CE QUE LA LECTURE PEUT AFFIRMER
  une contestation humaine de cette inférence est enregistrée

CE QUE CELA NE SIGNIFIE PAS
  que l'inférence n'a jamais existé
  que CCR ne l'a jamais produite
  qu'elle est rétrospectivement supprimée
  qu'elle est nécessairement fausse sur le fond
```

`HUMAN CONTESTATION ≠ RETROACTIVE DELETION`.

### Ce qui n'existe pas

Aucune valeur `CONFIRMED_TRUE`, `FALSE`, `VERIFIED_TRUTH`,
`RESOLVED`, `CLOSED`, `CONVERGED`, `WINNER`. Les deux actes disent qui a répondu
quoi, jamais ce qui est vrai.

### Histoire

```text
inférence CCR enregistrée     →  demeure dans l'histoire, avec son origine
confirmation ou contestation  →  nouvelle entrée d'autorité, append-only
```

Aucune promotion destructive, aucune mutation de provenance, aucun
`confidence → truth`.

## 16.5 Frontières de nommage

`EVIDENCE_CONFLICT` n'est réutilisé nulle part. Il reste un
statut Recovery décrivant deux faits durables incompatibles dans l'état du run.

Aucun type n'existe pour classer d'office, résoudre,
scorer, fusionner deux controverses, ou clore.

## 16.6 Relation aux événements existants

Les entrées V3 **référencent** `events.jsonl` par
`event_id` et ne le modifient jamais. Aucune relation inverse n'est écrite : un
événement n'apprend jamais qu'une controverse le vise.

Écrire dans les deux sens exigerait de muter un journal
append-only.

---

# 17. Idempotence et doublons

```text
doublon exact       même kind, même controverse, même attribution,
                    mêmes ancrages, même contenu
                    → refusé, avec un code de refus public

doublon sémantique  deux formulations proches du même point
                    → JAMAIS déduplique
```

Dédupliquer sur une similarité sémantique serait une
inférence non attribuée : exactement l'interdit. Deux entrées voisines
restent deux entrées.

Reprise après crash : une écriture d'entrée est un ajout en
fin de fichier ; une reprise qui retente la même écriture rencontre la garde de
doublon exact et ne crée pas de seconde ligne. Aucune opération V3 ne produit
d'effet fournisseur **sauf** la détection, qui suit le modèle d'engagement
durable et peut donc laisser un `UNKNOWN` — cas traité en §23.

---

# 18. Projection dérivée et read model

La lecture expose, par run :

```text
availability      NOT_AVAILABLE | AVAILABLE
recorded_count    nombre de controverses enregistrées
items[]           les controverses, dans l'ordre d'append

pour chaque controverse
  controversy_id · recorded_at · semantic_origin de l'enregistrement
  anchors[]                  ancrages de l'entrée d'enregistrement
  entries[]                  ordre d'append, jamais retrié
  authority_entries[]        entrées d'autorité, avec cibles et origines
  unresolvable_anchors[]     ancrages non résolus, nommés
```

## 18.1 Vérité du vide

Deux valeurs suffisent, et il n'en est créé aucune autre :

```text
NOT_AVAILABLE         run legacy — V3 ne s'y applique pas
                      JAMAIS recorded_count = 0

AVAILABLE             run natif V3-capable
  recorded_count = 0  signifie EXACTEMENT :
                      aucune controverse n'est enregistrée
```

La doctrine impose la distinction :

```text
recorded_count = 0   ≠   aucun désaccord n'existe
```

Le read model porte cette distinction explicitement ; il ne la laisse pas à
l'interprétation de son lecteur.

**Aucun état de détection n'est dupliqué ici.** Savoir si
une détection a été tentée, a échoué ou n'a rien produit relève de
l'`InvocationLedger`, qui en est l'autorité (§23). Le read model de controverses
ne le recopie pas.

## 18.1bis Réponses humaines aux inférences

La lecture expose les **entrées d'autorité elles-mêmes**,
dans l'ordre d'append, avec leur acte et leur origine. Elle n'en dérive aucun
booléen final.

Motif : une inférence peut recevoir une confirmation puis une
contestation, ou l'inverse. Compresser cela en `human_confirmed = true` effacerait
l'histoire et affirmerait un état que le journal ne porte pas.

Une projection du **dernier acte humain enregistré** est
admissible, à deux conditions strictes :

```text
elle s'appuie sur l'ordre d'append du journal V3, seul ordre autoritaire (§10.1)
son sens est EXACTEMENT « dernière réponse humaine enregistrée »
                    et JAMAIS « état de vérité »
```

**Aucun état épistémique total n'est produit.** Le dernier
acte est un fait de registre, pas un verdict.

## 18.2 Ce que la projection ne calcule jamais

```text
aucune disposition agrégée · aucun état · aucune couverture
un gagnant · un score · un degré d'accord
un regroupement par similarité · un tri par pertinence
un entrelacement avec le journal d'événements
```

Conformément à la doctrine, la projection est additive et versionnée,
composée depuis le **même instantané stable** que le reste du read model (§15.3),
et ne réécrit aucune valeur qu'elle transporte.

---

# 19. Opérations

Opérations minimales, évaluées une à une.

| Opération | Nécessaire ? | Pourquoi | Autorité | Effet fournisseur | Effet persistant |
|---|---|---|---|---|---|
| enregistrer une controverse | **OUI** | sans elle, rien n'existe | humain | `EXACT(0)` | une entrée |
| enregistrer une assertion | **OUI** | une controverse gagne des positions au fil des tours | humain | `EXACT(0)` | une entrée |
| déclarer une relation | **OUI** | seule façon d'exprimer contestation, reformulation, retrait | humain | `EXACT(0)` | une entrée |
| enregistrer une nature | **OUI** | facultatif | humain | `EXACT(0)` | une entrée |
| enregistrer une autorité humaine | **OUI** | explicitement admise | humain | `EXACT(0)` | une entrée |
| demander une détection | **OUI** | sur geste humain | humain | `AT_MOST(1)` ou `UNKNOWN` | 0..n entrées |
| confirmer une relation inférée | **OUI** | §16.4 | humain | `EXACT(0)` | une entrée |
| contester une relation inférée | **OUI** | symétrique de la précédente | humain | `EXACT(0)` | une entrée |
| supprimer une entrée | **NON** | append-only | — | — | — |
| fusionner deux controverses | **NON** | exigerait d'affirmer qu'elles portent sur la même chose | — | — | — |
| clore une controverse | **NON** | il n'existe aucun état à écrire | — | — | — |

## 19.1 Effet fournisseur — formulation exacte

La propriété est énoncée sans raccourci, parce qu'elle se
cite mal amputée de sa condition :

```text
toutes les opérations V3 NON DÉTECTION   →  EXACT(0)

la détection modèle                       →  peut appeler un fournisseur,
                                             selon son effet contractuel déclaré,
                                             et reste gouvernée comme telle
```

**Aucun résumé du type « V3 n'appelle aucun fournisseur »
n'est admissible.** V3 porte une capacité fournisseur ; elle est simplement
optionnelle, déclenchée par un humain, et comptée.

## 19.2 Fraîcheur requise

Toute mutation V3 exige le jeton `controversy_revision`
obtenu depuis un snapshot stable (§15.3–§15.4). Le jeton de run n'est pas exigé :
un tour d'expert ne périme pas une controverse.

---

# 20. Contrat cockpit

Le frontend n'est jamais autorité métier : la doctrine l'exclut, et ce contrat
ne lui ouvre aucune exception.

Le cockpit doit pouvoir répondre honnêtement à :

```text
des controverses sont-elles enregistrées, et combien
d'où vient chaque enregistrement — quelle origine sémantique
quelles contributions sont ancrées
lesquelles ont pour origine une source, un humain, ou CCR
quelles relations ont été déclarées, par qui, et de quel acte
une autorité humaine a-t-elle été enregistrée, et dans quel périmètre
quels ancrages ne se résolvent pas
```

Obligations de véracité :

```text
une controverse dont l'origine est CCR est visuellement distincte d'une
origine humaine ou source — jamais par la seule couleur

zéro controverse enregistrée s'affiche comme tel, avec sa signification :
ce n'est pas l'absence de désaccord

un ancrage non résolu se dit — jamais un extrait vide
```

**Aucun onglet, aucun écran, aucun workflow n'est prescrit.** Le contrat définit
des besoins d'information et des interdits ; le rang et l'emplacement relèvent de
la décision de produit.

Les contributions originales restent accessibles intégralement. Une
représentation secondaire renvoyant aux originaux est admissible ; elle ne les
remplace ni ne les falsifie.

## 20.1 Mutation depuis le cockpit

Le cockpit **expose les écritures de ce domaine**, par
`POST /api/runs/:id/controversies`, sur une union fermée d'opérations
([mutations-http.ts](../../src/cockpit/mutations-http.ts)).

Trois conséquences, et aucune quatrième :

```text
la validation reste server-authoritative — une surface d'entrée n'est
  jamais une autorité de validation

la fraîcheur exigée est celle de ce domaine (§19.2), jamais celle du run

aucune opération de ce domaine ne réserve de créneau d'opération longue,
  sauf la détection, qui est gouvernée comme tout appel fournisseur
```

Exposer une écriture ne déplace aucune autorité : le cockpit transporte un geste
humain, il ne le produit pas.

---

# 21. Frontière Recovery

Recovery traite la cohérence, la vivacité et la reprise
**opérationnelles** du run. Le blocage vient du prédicat
`requiresRecovery = state === 'WAITING_AGENT' || pending_operation !== null`
([run-liveness.ts](../../src/core/run-liveness.ts)), non du fait qu'un domaine
rapporte un statut non-`NONE`.

```text
un désaccord intellectuel ne crée AUCUN état Recovery
un désaccord ne bloque AUCUNE opération
aucun statut Recovery n'est ajouté pour « les experts divergent »
```

La persistance de ce domaine introduit une surface de corruption technique
propre : `controversies.jsonl` peut être illisible ou incohérent. Ce
cas relève de Recovery, **et il est distinct du désaccord lui-même** : un journal
de controverses corrompu est une anomalie du run ; une divergence entre experts
ne l'est pas.

Son traitement relève des autorités de reprise existantes, non du présent
contrat.

---

# 22. Gouvernance d'usage

Ce contrat **consomme** la gouvernance d'usage et n'en
duplique rien :

```text
InvocationLedger     autorité sur les invocations de détection
quota                admission avant appel, inchangée
DISPATCH_COMMITTED   engagement durable avant lancement, inchangé
UsageLedger          observations d'usage, inchangées
CostEstimate         dérivation, inchangée
```

Aucun second système de quota, aucun compteur propre à ce domaine, aucune
exemption.

La seule extension est l'ajout d'une valeur au vocabulaire de
déclencheurs d'invocation, avec sa conséquence de compatibilité énoncée en §13.4.

---

# 23. Sémantique d'échec

Pour une détection :

| Situation | Ce qui est écrit | Ce qui n'est jamais déduit |
|---|---|---|
| refus de quota avant engagement | aucune invocation, aucune entrée | « aucune controverse » |
| échec ou timeout après engagement | l'invocation existe au ledger avec son issue | « aucune controverse » |
| crash après `DISPATCH_COMMITTED` | l'invocation reste `UNKNOWN` | ni rejeu, ni restitution de budget |
| sortie inexploitable | l'invocation existe, aucune entrée n'est écrite | « aucune controverse » |

**Échec de détection ≠ absence de controverse.**

C'est pourquoi la lecture doit pouvoir dire qu'une
détection a été tentée sans produire de résultat. L'autorité sur les tentatives
est l'`InvocationLedger`, qui les porte déjà ; aucune structure d'échec propre à
à ce domaine n'est créée.

---

# 24. Versionnement et compatibilité

```text
schema_version           porté par chaque entrée
version inconnue         refus explicite à la lecture — jamais une ligne ignorée
                         en silence, jamais une controverse partielle
données V3 absentes      run normal, projection vide véridique
run legacy               V3 non disponible — voir §27
migration                aucune ; V3 n'écrit rien dans les runs existants
                         tant qu'aucune entrée n'est créée
```

La doctrine interdit de transformer une incertitude en succès. Une ligne de
version inconnue est une incertitude sur le contenu du
journal, donc un refus.

Aucune migration n'est décrite, prévue ni exécutée.

---

# 25. Ordre

Un ordre serveur autoritaire n'est jamais reconstruit par la présentation.

**Il n'existe aucun ordre total inter-journaux**, et le contrat l'assume
explicitement plutôt que de laisser croire qu'un entrelacement serait simplement
non produit.

```text
events.jsonl          ordre autoritaire de l'histoire opérationnelle
controversies.jsonl   ordre autoritaire de l'histoire des controverses
```

Aucune relation suffisante n'existe pour ordonner les deux
ensembles l'un par rapport à l'autre :

```text
based_on     n'existe pas sur les entrées V3
event refs   situent l'ancrage, pas le moment de l'écriture
round        granularité trop grossière — plusieurs entrées par tour
entry_id     ordonne les entrées V3 entre elles, jamais avec les événements
horodatage   interdit comme critère de tri
```

Ce qui existe est un **ordre partiel**, référentiel et non
chronologique : une entrée V3 ancre des événements, donc leur est postérieure ;
rien de plus n'est établi.

Interdits qui en découlent :

```text
aucune timeline mixte fabriquée par tri d'horodatages
aucune promesse de séquence du type
  contribution A → inférence → geste humain → contribution B
  si le modèle ne peut pas la prouver
```

Si une timeline mixte devenait un besoin établi, elle exigerait
une extension contractuelle dédiée définissant sur quoi l'ordre repose. Le contrat
ne la prépare pas et ne la présume pas nécessaire.

---

# 26. Sécurité

La doctrine pose `NO HTML RENDERER AS TRUST BOUNDARY`. Le Markdown est analysé par un lexer structuré, converti par un adaptateur CCR, puis
construit par nœuds DOM ; les liens sont `http`/`https` après analyse d'URL ;
l'HTML brut est rendu comme texte ; les images distantes ne sont pas rendues.

Ce contrat ne contourne rien de cela :

```text
tout contenu V3 — énoncé, nature, motif, périmètre — est du texte non fiable
il traverse exactement le même chemin de rendu que les contributions
aucun nouveau sink n'est introduit
```

Un ancrage textuel est un couple de nombres. Il ne peut pas
porter d'injection. L'extrait qu'il désigne reste du texte non fiable et suit le
chemin de rendu existant.

Les contenus V3 sont bornés en taille à l'écriture, avec
refus public au-delà — même discipline que le garde-fou de transfert
([transfer.ts](../../src/services/transfer.ts)), qui refuse plutôt que de
tronquer.

---

# 27. Frontière legacy

**V3 est native-only.**

```text
run NATIVE_V21_EXECUTION   V3 disponible
run LEGACY_V2_EXECUTION    V3 NOT_AVAILABLE — jamais « zéro controverse »
```

La génération d'un run se décide une fois et ne change jamais ; une mutation
n'emporte pas une migration.

Un run d'une génération antérieure reste intégralement lisible. Aucune capacité
existante n'est retirée. La projection expose explicitement
`NOT_AVAILABLE` avec son motif générationnel, et non une liste vide qui
laisserait croire qu'on a regardé.

---

# 28. Frontière V4

**V3 ne stocke aucune relation vers une preuve.**

Une controverse est parfaitement représentable sans aucune
notion de preuve — deux positions divergent, chacune ancrée et attribuée. Ajouter
dès V3 un lien « cette position invoque quelque chose » serait une commodité pour
V4 déguisée en besoin de V3.

Aucune structure `Evidence`, `EvidenceClaim`,
`EvidenceGraph`, aucun poids, aucune crédibilité, aucun score de preuve.

La compatibilité ascendante est assurée par la forme, non par
un champ : le journal est append-only et versionné, donc V4 pourra ajouter ses
propres types d'entrées sans réécrire quoi que ce soit.

---

# 29. Frontière V5

V3 ne réconcilie pas :

```text
aucun gagnant · aucun consensus · aucun score de résolution
aucun score d'accord · aucun détecteur de convergence
aucune recommandation
```

**Aucune donnée n'est rendue obligatoire au motif que V5 en
aurait besoin.** Ce que V3 préserve — l'histoire append-only, attribuée et
ancrée — est nécessaire à V3 lui-même. Que V5 puisse un jour s'en servir est une
conséquence, pas une justification.

---

# 30. Frontière Mission / Stream

Run-local.

```text
pas de controverse trans-run          pas de transfert entre runs
pas d'identité durable globale        pas d'ownership Mission / Stream
```

La survie d'une controverse au-delà d'un run, sa
propriété et son identité durable relèvent du chantier parallèle. Non implémenté
dans V3, et non préparé par un champ spéculatif.

---

# 31. Scénarios normatifs

Huit cas, chacun testant une frontière du contrat.

## CASE 1 — Le Challenger déclare explicitement une objection

```text
PEUT ÊTRE ENREGISTRÉ   le texte existe déjà comme assistant_response
                       une entrée peut l'ancrer et citer sa localisation
PEUT ÊTRE INFÉRÉ       rien de plus que ce que le texte porte
NE DOIT PAS ÊTRE DIT   « X est controversé » sans attribution
```

**Aucune entrée d'origine `SOURCE` n'est productible en V3
initial** (§5.2bis). CCR ne peut pas reconnaître la déclaration de façon
déterministe (§14), et une transcription humaine est `kind = HUMAN` avec
`about_actor` (§5.2) — jamais `SOURCE`.

`SOURCE` reste une catégorie définie, réservée à une sémantique effectivement
produite par la source. Le protocole expert qui permettrait de l'alimenter
n'existe pas et exigerait son propre contrat.

## CASE 2 — Auteur et Challenger semblent incompatibles sans le dire

```text
PEUT ÊTRE ENREGISTRÉ   un enregistrement d'origine HUMAN, si un humain le juge
                       un enregistrement d'origine CCR, après détection demandée
PEUT ÊTRE INFÉRÉ       « CCR a inféré une divergence entre A et B sur X »
NE DOIT PAS ÊTRE DIT   « A et B sont en désaccord sur X », sans qualification
```

## CASE 3 — Une détection modèle signale une divergence potentielle

```text
PEUT ÊTRE ENREGISTRÉ   CONTROVERSY_RECORDED · semantic_origin.kind = CCR
                       derivation { MODEL_ASSISTED, invocation_id, inputs }
PEUT ÊTRE INFÉRÉ       ce que la dérivation énonce, avec ses entrées
NE DOIT PAS ÊTRE DIT   que l'inférence est confirmée · qu'elle vaut assertion
                       d'expert · qu'un score la valide
```

## CASE 4 — L'Auteur retire une position

```text
PEUT ÊTRE ENREGISTRÉ   RELATION_RECORDED, act = WITHDRAWS, vers l'entrée visée
PEUT ÊTRE INFÉRÉ       que son auteur ne la soutient plus
NE DOIT PAS ÊTRE DIT   que l'autre position est vraie · consensus
                       controverse close · remédiation acceptée
```

Aucune disposition n'est recalculée : la lecture expose la
relation enregistrée, sa cible et son origine. Rien d'autre n'est affirmé, et
surtout pas que la controverse aurait changé d'état.

## CASE 5 — L'humain arbitre une troisième option

```text
PEUT ÊTRE ENREGISTRÉ   HUMAN_AUTHORITY_RECORDED, avec son périmètre énoncé
PEUT ÊTRE INFÉRÉ       qu'une autorité normative existe pour ce périmètre
NE DOIT PAS ÊTRE DIT   que les experts se sont accordés
                       que les positions antérieures sont effacées
                       que ce qui est hors périmètre est tranché
```

## CASE 6 — Plus aucune mention pendant plusieurs tours

```text
PEUT ÊTRE ENREGISTRÉ   rien — aucune entrée n'est produite par le temps
PEUT ÊTRE INFÉRÉ       « aucune entrée d'autorité n'est enregistrée »
NE DOIT PAS ÊTRE DIT   inactive · dormante · résolue · close · ouverte
```

Rien ne change, et rien ne pourrait changer : aucun
mécanisme n'écrit d'entrée sans acteur, et aucune valeur n'est agrégée.

## CASE 7 — Détection refusée par le quota

```text
PEUT ÊTRE ENREGISTRÉ   le refus, par les primitives de quota — aucune invocation
                       n'est créée avant engagement
PEUT ÊTRE INFÉRÉ       qu'une détection a été demandée et refusée
NE DOIT PAS ÊTRE DIT   qu'aucune controverse n'existe
```

## CASE 8 — Deux controverses sur deux passages d'une même contribution

```text
PEUT ÊTRE ENREGISTRÉ   deux controverses distinctes, deux identités,
                       deux TextualAnchor citant deux fragments du même event_id
PEUT ÊTRE INFÉRÉ       rien sur leur relation
NE DOIT PAS ÊTRE DIT   qu'elles portent sur le même sujet
                       qu'elles devraient être fusionnées
```

C'est le cas qui justifie l'ancrage multi-niveaux : sans
`TextualAnchor`, les deux controverses seraient indiscernables par leur
provenance.

---

# 32. Modèle d'acceptation

La classe de preuve exigible pour chaque comportement du domaine. Ce tableau
n'est pas un compte rendu d'exécution : il dit ce qu'une validation doit
produire pour être opposable.

| Comportement | Classe attendue | Justification |
|---|---|---|
| forme et validation des entrées | `STATIC` + `FIXTURE` | pur, déterministe, sans processus |
| refus d'une version de schéma inconnue | `FIXTURE` | fixture de journal malformé |
| validation des ancrages, frontières UTF-8 | `FIXTURE` | cas limites construits |
| `ANCHOR_UNRESOLVABLE` | `FIXTURE` | exige un événement absent — non reproductible en réel |
| append-only, absence de réécriture | `STATIC` + `AUTOMATED_REAL_PROCESS` | garde de source, puis fichiers réels |
| doublon exact refusé | `FIXTURE` | déterministe |
| absence totale de champ de statut **et** de disposition agrégée | `STATIC` | garde de source — c'est l'invariant central |
| journal des controverses participant au snapshot stable | `AUTOMATED_REAL_PROCESS` | exige des fichiers réels mutés pendant la lecture |
| refus plutôt que vue composite jamais coexistante | `AUTOMATED_REAL_PROCESS` | même raison |
| absence stable du journal sur un run natif antérieur | `AUTOMATED_REAL_PROCESS` | fichier réellement absent |
| ancrage textuel : citation retrouvée, occurrence respectée | `FIXTURE` | déterministe |
| ancrage refusé à l'écriture si l'occurrence n'existe pas | `FIXTURE` | déterministe |
| une entrée ne porte qu'une unité sémantique | `STATIC` + `FIXTURE` | garde de forme |
| une relation ne modifie jamais l'entrée visée | `STATIC` | garde de source — append-only |
| `controversy_revision` additive, `revision` existante inchangée octet pour octet | `AUTOMATED_REAL_PROCESS` | fichiers réels, comparaison octet |
| concurrence de deux écrivains | `AUTOMATED_REAL_PROCESS` | processus et verrous réels |
| projection véridique, états vides | `FIXTURE` | jeux construits |
| génération antérieure rendue `NOT_AVAILABLE` | `REAL_NOW` | de tels runs existent au store de validation |
| lecture sur runs natifs réels | `REAL_NOW` | des runs natifs réels existent au store de validation |
| détection modèle bout en bout | `REAL_NOW` | exige une invocation fournisseur réelle ; c'est la condition de levée de la porte du §13.5 |
| compatibilité de version du ledger — lecteur ancien refusant lisiblement | `FIXTURE` | ledger construit à la version supérieure |
| gouvernance de la détection | `FIXTURE` puis `AUTOMATED_REAL_PROCESS` | fournisseur doublé ; le ledger et le quota sont réels |
| absence de sink de rendu | `STATIC` | garde de source |

Un critère `NOT_TESTED` interdit de déclarer un comportement achevé : il doit
alors être rapporté `IMPLEMENTED / NOT EMPIRICALLY VERIFIED`, et non `DONE`.

Aucun comportement n'est annoncé `REAL_NOW` sans qu'un scénario réel
correspondant soit disponible.

---

# 33. Ce que ce contrat ne couvre pas

Trois questions restent **hors du présent contrat**, et sont nommées pour
qu'aucune lecture ne les prenne pour des omissions :

```text
décision de run native      aucun modèle général n'existe ; ce contrat
                            n'enregistre que l'autorité de son domaine (§12)

journal corrompu            son traitement relève des autorités de reprise
                            existantes, non d'ici (§21)

identité trans-run          la survie d'une controverse au-delà d'un run
                            relève d'un chantier distinct (§30)
```

Aucune des trois n'est préparée par un champ spéculatif.

La propriété que ce contrat existe pour tenir, et la seule qui doive résister à
une contre-expertise :

> **CCR sait voir, consigner et suivre la structure d'un désaccord, et n'acquiert
> nulle part le droit d'en décider l'issue.**

Deux moyens y concourent, tous deux structurels plutôt que réglementaires :
aucun champ de statut n'existe, et aucune agrégation n'est calculée. Ce que le
modèle ne peut pas attribuer, il ne le représente pas.
