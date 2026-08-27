# CCR — Spécification · Matériaux et adductions

```text
STATUT   contrat courant
PORTÉE   contrat métier · local à un run
```

Ce document définit comment un **matériau** est retenu au dossier, et comment une
**adduction** le verse au débat à propos d'une cible.

Il décrit le **contrat courant**, avec la précision nécessaire pour contribuer.
Il ne remplace pas la doctrine : pour ce que CCR affirme et refuse d'affirmer,
voir [`../doctrine.md`](../doctrine.md).

---

# 1. Le finding central, résolu

## 1.1 `LA RÉTENTION N'EST PAS L'INVOCATION`

CCR écrit quatre fichiers par tour — `prompt`, `response`,
`stdout`, `stderr` — qu'aucun fait canonique ne référence
([native-round-store.ts](../../src/store/native-round-store.ts)). Il conserve
donc déjà du matériau que personne n'a versé au débat.

Ce contrat porte **deux concepts canoniques distincts**, avec des identités
distinctes :

```text
MATÉRIAU     un objet enregistré, identifié, dont CCR sait ce qu'il en a observé
ADDUCTION    un acte historique : un acteur verse ce matériau à propos d'une cible
```

**Terme d'art, et sa borne.** « Adduire » signifie
*verser un matériau au débat*, et **rien d'autre**. Le mot ne dit jamais que
l'acteur a créé, écrit, fourni ou possédé ce matériau. Lorsque le contrat
emploie le verbe « produire », c'est au sens juridique de *produire une pièce au
débat* — jamais au sens de fabriquer.

Une adduction **référence** un matériau ; elle n'en est
jamais une propriété. Il est **interdit** de représenter une adduction comme un
champ mutable du matériau, comme un statut du matériau, ou comme un compteur.

## 1.2 Cardinalités imposées

Un matériau enregistré doit pouvoir être produit :

```text
zéro fois · une fois · plusieurs fois
par des acteurs différents · vers des cibles différentes
avec des orientations différentes, y compris contradictoires
```

Un matériau n'est **jamais** dupliqué pour représenter une
nouvelle production.

## 1.3 Le mot retenu, et pourquoi

Le concept est celui que l'autorité humaine nomme
« invocation probatoire ». Le littéral du contrat est **`ADDUCTION`**.

`invocation_id` désigne déjà, depuis V2.2, un **appel
fournisseur gouverné** ([usage-governance.ts](../../src/core/usage-governance.ts)).
Employer « invocation » pour deux objets d'un même run produirait exactement le
défaut que le dépôt refuse partout ailleurs : deux sens autoritaires sous un
seul mot.

Le mot `evidence` survit au niveau du **moteur** et du
**journal**, où l'usage l'a établi. Il est **interdit** au niveau des
genres d'entrée, des champs et des valeurs, où la confusion serait opérante.

---

# 2. Identité du matériau

## 2.1 Forme

Identité canonique, séquentielle, **server-authoritative**,
run-locale :

```text
material_id   mat_NNNNNN     N ≥ 6 chiffres, séquence strictement croissante
```

Même discipline canonique que `ctv_` / `ctve_` : la forme
exacte est exigée, et un identifiant est refusé si `format(parse(id)) !== id`.
Aucune absorption de zéros de tête, aucune longueur non bornée admise en silence.

L'appelant ne forge jamais un `material_id`.

## 2.2 Ce que l'identité **ne** dit **pas**

Formalisé, et opposable à toute lecture :

```text
même material_id       →  même enregistrement canonique dans ce run
material_id différent  ↛  matériaux différents dans le monde
mêmes octets, même empreinte  ↛  obligation de partager un material_id
même URL               ↛  même contenu
```

Ce contrat ne crée **aucune autorité d'équivalence externe**. CCR
ne déclare jamais que deux matériaux sont « le même ».

## 2.3 Portée

`INITIAL_MATERIAL_IDENTITY_SCOPE = RUN_LOCAL`.

Aucun registre transverse n'est créé. La réutilisation
inter-run est `MISSION_STREAM_DEFER`.

Hors périmètre : identité universelle, identité inter-run, déduplication par
sens, immutabilité du monde extérieur.

---

# 3. Représentation du matériau

## 3.1 Périmètre initial

```text
INITIAL_MATERIAL_REPRESENTATION_SCOPE = TROIS FORMES
```

Trois formes, et trois seulement. Elles ne sont **pas** une
taxonomie argumentative : elles se distinguent **uniquement** parce que la
vérification déterministe possible n'est pas la même.

```text
RUN_EVENT           le matériau EST un événement canonique de ce run
                    identifié par event_id · CCR détient le contenu

INLINE_TEXT         texte fourni par l'appelant, capturé verbatim dans
                    l'enregistrement · CCR détient le contenu

EXTERNAL_REFERENCE  un localisateur enregistré comme chaîne, et rien d'autre
                    CCR ne détient AUCUN contenu
```

**`REPRESENTATION FORM ≠ EVIDENCE QUALITY`**. Aucune des
trois n'est plus forte, plus fiable ou plus probante qu'une autre. Aucune lecture,
aucune présentation ne peut les ordonner.

Justification de la distinction, et elle seule : une
citation ne peut être vérifiée que si CCR détient une représentation. Les deux
premières formes l'autorisent, la troisième l'interdit. Sans cette conséquence
mécanique, aucune des trois n'existerait.

## 3.2 `EXTERNAL_REFERENCE` — ce qui est réellement enregistré

Enregistrer une référence externe établit exactement ceci :

> **« cette chaîne a été enregistrée comme localisateur, par cet acteur, à cette
> date. »**

Cela n'établit **jamais** que CCR a observé le contenu
désigné, qu'il existe, qu'il est accessible, ou qu'il est stable.

**Aucune récupération réseau.** Ce domaine n'effectue aucun `fetch`, aucune résolution, aucun rendu actif d'un localisateur.

Une empreinte déclarée par l'appelant peut être conservée,
et elle est alors marquée **déclarée**, jamais **vérifiée**. CCR ne l'a pas
calculée.

## 3.3 Ce qui est différé

Hors périmètre : les artefacts de tour (`rounds/<n>/*`) ne sont **pas** une
forme de matériau. Les admettre exigerait de fixer une identité
de fichier et une politique d'empreinte dont aucun usage observé n'a besoin. La
question reste ouverte, sans dette.

---

# 4. Provenance du matériau

Un enregistrement de matériau conserve les faits que CCR
connaît réellement, et **seulement** eux :

```text
recorded_by          l'acteur d'enregistrement — CCR, toujours, comme scribe
submitted_by         l'origine sémantique de la SOUMISSION : HUMAN uniquement
                     (§10.2)
recorded_at          horodatage CCR
representation       la forme du §3.1, et ce qu'elle porte
observed_by_ccr      booléen structurel : CCR détient-il une représentation ?
declared_digest      optionnel, marqué DÉCLARÉ — jamais calculé par CCR
```

`UNKNOWN ≠ provenance inventée`.

Il est **interdit** d'inscrire, lorsqu'ils n'ont pas été
observés : un fournisseur, un modèle, un commit Git, un auteur externe, un
contenu d'URL, une immutabilité externe, une date de création externe.

La provenance **du matériau** est distincte de l'origine
sémantique **de la production** (§10). Un matériau peut provenir d'un expert,
d'un tiers, d'un document : cela ne fait jamais de cette origine l'auteur d'une
production.

---

# 5. Acteur `evidence` hérité

L'acteur `evidence` des journaux d'événements **n'est pas réemployé** par ce
domaine.

Le modèle **n'emploie pas** l'acteur `evidence` des
vocabulaires `EVENT_ACTORS` / `NATIVE_EVENT_ACTORS`. Motif technique, non
nominal : ce domaine n'écrit **aucun** événement dans `events.jsonl` (§14.4), la question
d'un acteur d'événement ne se pose donc pas.

Aucun interdit perpétuel n'est créé. Le littéral reste
réservé et admis en lecture, exactement comme aujourd'hui.

---

# 6. Cibles

## 6.1 Ensemble initial

**Une seule** sorte de cible :

| Sorte | Pourquoi maintenant | Identité canonique | Autorité de validation |
|---|---|---|---|
| `CONTROVERSY_ENTRY` | c'est le lieu où vivent les énoncés contestés — la raison d'être d'une production probatoire | `ctve_NNNNNN` | résolution dans le journal V3 du **même run**, via le snapshot stable |

Cette sorte unique couvre, sans en ajouter aucune : une
assertion, une relation, l'ouverture d'une controverse, une nature, une autorité
humaine. Toutes sont des entrées du journal V3 et portent un `entry_id`.

**Une cible est une entrée, jamais un agrégat.** Une
adduction visant l'entrée d'ouverture d'une controverse vise **exactement cette
entrée**. Elle ne vise pas la controverse comme tout, et le contrat n'affirme
aucune équivalence entre les deux identités canoniques :

```text
ctve_NNNNNN   identité d'une ENTRÉE       ← seule identité qu'une cible porte
ctv_NNNNNN    identité d'une CONTROVERSE  ← jamais une cible ici
```

Aucun besoin de viser l'agrégat n'a été démontré. Une
sorte de cible `CONTROVERSY` n'est donc **pas** créée par anticipation. Si un
tel besoin apparaissait, ce serait une extension additive de l'ensemble des
sortes, sans changement de l'énoncé d'autorité de ce contrat.

## 6.2 Ce qui est différé, et pourquoi

Hors périmètre : Sont exclus, faute d'usage observé :
un événement de run · une invocation fournisseur · une décision legacy · le run
lui-même · une opération · un autre matériau · une autre production.

Les admettre plus tard serait une extension additive de l'ensemble des sortes,
sans changement de l'énoncé d'autorité de ce contrat.

## 6.3 Identité de cible

Une cible est **canonique**. Aucune cible en texte libre,
aucun localisateur, aucun sélecteur.

CCR doit pouvoir revalider déterministement :
l'**existence** de l'entrée, sa **sorte** admissible, et son **appartenance au
run**.

Aucune sémantique inter-run n'est créée, ni explicitement,
ni par effet de bord d'un identifiant qui se résoudrait ailleurs.

---

# 7. Orientation

Littéraux, union fermée, **champ obligatoire** :

```text
orientation ∈ { 'NONE', 'SUPPORTS', 'OBJECTS_TO' }
```

`NONE` est une **valeur**, jamais une absence. Le champ est
présent sur toute production. Il est **interdit** de représenter l'absence
d'orientation par un champ absent, `null`, une chaîne vide ou une valeur par
défaut implicite. L'absence d'orientation ne doit pas pouvoir être reconstruite
comme une position cachée, et un champ absent est exactement ce qui rendrait
cette reconstruction possible.

Formalisé et opposable :

```text
SUPPORTS    ≠  la cible est vraie
OBJECTS_TO  ≠  la cible est fausse
NONE        ≠  sans pertinence · ≠ doute · ≠ soutien faible · ≠ neutralité de l'acteur
```

Une orientation est **déclarée par un acteur**. Elle n'est
jamais un constat de CCR. Aucune surface ne peut la calculer, l'inférer, la
compléter, la corriger ni la déduire d'un texte.

---

# 8. Genres d'entrée et identités

Deux genres, et deux seulement :

```text
MATERIAL_RECORDED    enregistrement d'un matériau
ADDUCTION_RECORDED   acte historique de production au débat
```

Identités :

```text
material_id    mat_NNNNNN    séquence propre au journal V4
adduction_id   add_NNNNNN    séquence propre au journal V4
```

Les deux séquences sont **indépendantes**, strictement
croissantes, et allouées par le service sous le verrou de run.

---

# 9. Enveloppe d'entrée

Une seule enveloppe, discriminée par `kind`. Aucun champ de
mutation d'état n'y figure — ni `status`, ni `active`, ni `closed`, ni `deleted`,
ni `superseded`, ni compteur.

```text
COMMUN
  entry_id        mat_NNNNNN | add_NNNNNN
  kind            MATERIAL_RECORDED | ADDUCTION_RECORDED
  recorded_by     CCR                       — le scribe, toujours
  recorded_at     horodatage CCR
  schema_version  version du journal V4

MATERIAL_RECORDED
  submitted_by    HUMAN
  representation  RUN_EVENT { event_id }
                | INLINE_TEXT { text }
                | EXTERNAL_REFERENCE { locator, declared_digest? }
  label           texte court, borné, facultatif — jamais une catégorie

ADDUCTION_RECORDED
  material_id     mat_NNNNNN
  target          { kind: 'CONTROVERSY_ENTRY', entry_id: ctve_NNNNNN }
  orientation     NONE | SUPPORTS | OBJECTS_TO
  semantic_origin HUMAN | CCR
  derivation      exigée si semantic_origin = CCR, interdite sinon
                  { method: 'MODEL_ASSISTED', invocation_id, inputs[] }
  citation        facultative — { quoted_text, occurrence }
```

`label` est un texte libre borné destiné à l'humain. Il
n'est **jamais** une catégorie, ne participe à aucun regroupement, à aucun tri,
à aucun filtrage autoritaire.

La cardinalité est portée par la **forme** : `citation` est
un champ unique, jamais une liste. Une production porte au plus une citation.

---

# 10. Origine sémantique

## 10.1 Vocabulaire admis

Le contrat admet exactement deux origines sémantiques de production : `HUMAN`, et `CCR / MODEL_ASSISTED` sur geste humain explicite.

Représentation :

```text
semantic_origin = 'HUMAN'   →  derivation INTERDITE
semantic_origin = 'CCR'     →  derivation EXIGÉE, method = 'MODEL_ASSISTED'
```

`derivation.method` n'admet **qu'une seule valeur**.
Une production CCR déterministe n'est **pas** admise par l'autorité humaine ; sa
représentation n'existe donc pas, et le contrat ne la prépare pas. L'introduire
exigerait une **nouvelle décision humaine**, pas une extension technique.

Une origine `SOURCE` — un expert produisant lui-même une
pièce — n'est pas admise. Même conséquence : nouvelle décision humaine requise.

## 10.2 `RECORDER ≠ SEMANTIC ORIGIN`

`recorded_by` vaut **toujours** `CCR` : CCR tient le
journal. Cela ne fait jamais de CCR l'auteur sémantique d'une production
`HUMAN`.

Le fournisseur n'est **jamais** promu au rang d'origine
sémantique. `claude` et `codex` n'apparaissent nulle part dans une entrée V4. Le
moteur qui a servi une production `MODEL_ASSISTED` se lit dans le ledger
d'invocation, par `invocation_id`, et là seulement.

## 10.3 Provenance du matériau ≠ auteur de la production

Un matériau peut provenir d'un expert, d'un tiers, d'un
document. Cela ne fait pas de cette source l'auteur d'une production, et toute
présentation qui les confondrait est interdite (§32).

---

# 11. Opérations humaines — zéro fournisseur

## 11.1 Enregistrement d'un matériau

```text
OPÉRATION          registerMaterial
PROVIDER_EFFECT    EXACT(0)
```

Entrées de l'appelant : la forme de représentation et sa
charge, un `label` facultatif, et la révision V4 attendue.

Champs **server-authoritative**, jamais forgés par
l'appelant : `entry_id`, `recorded_at`, `recorded_by`, `submitted_by`,
`schema_version`, et la révision résultante.

Bornes d'écriture, refus et jamais troncature :

```text
INLINE_TEXT.text          ≤ 256 Kio, alignée sur MAX_CONTROVERSY_TEXT_BYTES
EXTERNAL_REFERENCE.locator ≤ 4 Kio
label                     ≤ 4 Kio
declared_digest           forme canonique exigée si présent
```

`MATERIAL REGISTERED ≠ MATERIAL ADDUCED`. Cette opération
ne produit **jamais** de production, ni automatiquement, ni sur option.

Un `RUN_EVENT` doit résoudre dans le journal natif du même
run. Un `event_id` inconnu est un refus déterministe.

## 11.2 Production humaine

```text
OPÉRATION          adduceMaterial
PROVIDER_EFFECT    EXACT(0)
```

L'humain choisit explicitement : le matériau, la cible,
l'orientation, et éventuellement une citation. Rien de ces quatre n'est déduit.

Conditions structurelles obligatoires :

```text
material_id résout dans le journal V4 du run
target.entry_id résout dans le journal V3 du run
orientation ∈ union fermée
si citation : le matériau doit être détenu (RUN_EVENT ou INLINE_TEXT)
              et quoted_text doit apparaître exactement à occurrence
```

## 11.3 Matériau non vérifiable et production humaine

`non vérifiable ≠ faux`.

Une production humaine **est autorisée** vers un matériau
de forme `EXTERNAL_REFERENCE`, dont CCR n'a observé aucun contenu. Elle est
enregistrée honnêtement : le fait produit est l'acte humain, et la vérifiabilité
dérivée du matériau dit ce que CCR n'a pas observé (§16).

La seule restriction est mécanique et non doctrinale : une
**citation** est impossible sur un matériau non détenu, puisqu'il n'existe aucune
représentation à confronter. Le refus porte sur la citation, jamais sur la
production.

---

# 12. Opération assistée par modèle

## 12.1 Geste humain exclusivement

`HUMAN-ACTION-ONLY`. Une opération `MODEL_ASSISTED` :

```text
n'est jamais automatique
exige un geste humain explicite, portant un périmètre explicite
ne peut être déclenchée par START, STEP, SEND, HANDOFF, RECOVERY
ne peut être déclenchée par une lecture, un read model, un rafraîchissement
ne peut être déclenchée par l'enregistrement d'un matériau
```

## 12.2 Périmètre de la demande

Le plus petit périmètre permettant `M1`–`M4` :

```text
l'humain nomme UN matériau détenu
et UNE controverse, par son entrée d'ouverture
```

L'ensemble soumis est calculé par le serveur en phase A :
la représentation détenue du matériau nommé, et les entrées de la controverse
nommée. Le fournisseur ne choisit **jamais** de nouveaux matériaux ni de
nouvelles cibles hors de cet ensemble.

Un matériau de forme `EXTERNAL_REFERENCE` **ne peut pas**
être le sujet d'une demande `MODEL_ASSISTED` : CCR ne détient aucun contenu à
soumettre, et soumettre un localisateur seul reviendrait à demander au modèle de
raisonner sur une chose qu'il n'a pas vue.

## 12.3 Gouvernance

Tout appel modèle de ce domaine est une invocation CCR gouvernée, au même titre
que les autres.

Sans exception :

```text
quota vérifié AVANT tout engagement
invocation_id alloué par CCR
DISPATCH_COMMITTED durable AVANT l'appel
InvocationLedger renseigné
usage observé, jamais inventé
fournisseur dérivé du contexte gouverné — jamais choisi par l'appelant
aucune reprise automatique, aucun second appel implicite
```

## 12.4 Déclencheur

Nouveau littéral de déclencheur, sans réutilisation :

```text
EVIDENCE_ADDUCTION
```

Réutiliser `CONTROVERSY_DETECTION` est **interdit** : il
dit pourquoi une invocation a été engagée, et une demande de production n'est pas
une détection de controverse. Un journal qui ment sur la raison d'un appel ne
vaut rien comme autorité — la règle est celle que V3 a déjà posée.

---

# 13. Compatibilité du ledger d'invocation

Le ledger d'invocations porte sa version **par enregistrement**, jamais par
fichier, et la choisit d'après la **charge**
([usage-governance.ts](../../src/core/usage-governance.ts)).

L'adduction possède son propre déclencheur, et n'en réemploie aucun autre :

```text
EVIDENCE_ADDUCTION   →  version de ledger ÉCRITE : 3
```

Motif, et c'est le raisonnement déjà tenu pour la détection de controverse :
ajouter ce déclencheur au vocabulaire de la version 2 rendrait un lecteur
antérieur incapable de lire un enregistrement qu'il croit pourtant comprendre —
il verrait une version qu'il admet, portant une valeur qu'il refuse, et
**rejetterait le journal entier**. Une version propre le laisse refuser
exactement ce qu'il ne connaît pas, ligne par ligne, sans rien prétendre sur le
reste.

**Deux matrices distinctes**, qu'il est interdit de confondre : « la version 3
porte `EVIDENCE_ADDUCTION` » ne dit pas « la version 3 ne porte que cela », et
ne dit pas davantage « la version 3 est la dernière ».

**Matrice 1 — déclencheurs ADMIS À LA LECTURE, par version.** Strictement
additive :

| Version lue | Déclencheurs admis |
|---|---|
| `1` | `START` · `STEP` · `SEND` · `RECOVERY_CONTINUE` |
| `2` | tous ceux de la version 1, **plus** `CONTROVERSY_DETECTION` |
| `3` | tous ceux de la version 2, **plus** `EVIDENCE_ADDUCTION` |
| `4` | tous ceux de la version 3, **plus** `RECONCILIATION_PROPOSAL` |
| inconnue | aucun — refus explicite de cet enregistrement, jamais un saut |

**Matrice 2 — version CHOISIE PAR LE WRITER, par déclencheur.** Inchangée pour
tout ce qui existait :

| Déclencheur écrit | Version écrite | Statut |
|---|---|---|
| `START` · `STEP` · `SEND` · `RECOVERY_CONTINUE` | `1` | **INCHANGÉ** — historique |
| `CONTROVERSY_DETECTION` | `2` | **INCHANGÉ** |
| `EVIDENCE_ADDUCTION` | `3` | **le déclencheur de ce domaine** |
| `RECONCILIATION_PROPOSAL` | `4` | appartient au domaine de la réconciliation |

Le ledger courant admet donc **les versions 1 à 4**. La version 3 est celle que
ce domaine **écrit** ; elle n'est pas le plafond courant du ledger, et le
présent contrat ne définit ni ne possède la version 4.

La version suit **la charge**, jamais le millésime du runtime. Un `SEND` écrit
après une adduction reste en version 1 ; une détection de controverse reste en
version 2. Aucun writer ne « monte » un enregistrement.

Un journal **mixte** reste lisible :

```text
v1 · v2 · v3 · v4 · v1 · v2   →  lecture complète par un lecteur courant
```

**Aucune sémantique antérieure n'est modifiée.** Aucun vocabulaire de version
n'est élargi rétroactivement, et aucun enregistrement historique n'est réécrit,
requalifié, migré ni relu sous une autre version. Un lecteur antérieur refuse exactement ce qu'il ne connaît pas —
ligne par ligne, sans rien prétendre sur le reste.

---

# 14. Persistance

## 14.1 Journal

Un journal V4, run-local, append-only :

```text
<runsDir>/<run_id>/evidence.jsonl
```

Douzième chemin de `RunPaths`, additif. Son absence est
l'état normal de tout run antérieur à V4 : décrire un chemin ne matérialise pas
la source.

Le nom du fichier nomme le **moteur**, pas une qualité.
Aucune entrée, aucun champ, aucune valeur ne porte le mot `evidence`.

## 14.2 Version de schéma

`EVIDENCE_JOURNAL_SCHEMA_VERSION = 1`, portée **par
enregistrement**. Elle est **sans rapport** avec les versions du ledger
d'invocation et avec celle du read model.

Une version inconnue interdit une lecture complète : refus
explicite, jamais un saut de ligne, jamais une lecture partielle présentée comme
entière.

## 14.3 Discipline JSONL

Reprise sans altération de la discipline V3 :

```text
append-only · une entrée par ligne · aucune réécriture
seul le fragment final non terminé est traité comme non encore écrit
une ligne TERMINÉE invalide est une corruption stable, jamais une fin de journal
un refus ne crée jamais le fichier
```

## 14.4 Étanchéité

Ce domaine n'écrit **jamais**, par aucune voie, dans
`events.jsonl`, `decisions.jsonl`, `controversies.jsonl`, `manifest.json`,
`state.json` ni `invocation-policy.json`.

Il écrit **en propre** dans `evidence.jsonl`, et là seulement.

Pour une opération `MODEL_ASSISTED` uniquement,
`invocations.jsonl` et `usage.jsonl` sont alimentés **par les primitives de
gouvernance existantes**, que ce domaine appelle sans les contourner et sans
jamais y écrire en direct. Ce n'est pas une écriture du domaine : c'est l'effet
normal d'une
invocation gouvernée.

Aucune autorité du journal des controverses n'est modifiée : ce domaine
référence des `ctve_`, il n'en écrit aucun.

---

# 15. Snapshot, révision, fraîcheur

## 15.1 Participation au snapshot stable

Le snapshot stable d'un run natif observe **six sources physiques
autoritaires** ([native-run-snapshot.ts](../../src/store/native-run-snapshot.ts)) :
l'identité et l'état du run, sa chronologie canonique, et les trois journaux de
domaine.

`evidence.jsonl` en est **une source observée à part entière**. Il n'est pas lu
à côté du snapshot : il en fait partie. Le motif est celui qui vaut pour chaque
journal de domaine — écrire sous le verrou ne suffit pas ; sans observation, une
lecture combinée pourrait rendre un état de run et un journal qui n'ont jamais
coexisté.

Son absence produit la signature stable `ABSENT`, comme les autres. Aucun run
antérieur ne voit son journal créé pour être lu.

Ce contrat ne décrit ni ne gouverne les autres journaux de domaine ; il constate
seulement la frontière à laquelle le sien appartient.

## 15.2 Révision de run — inchangée

`revision` reste calculée sur `manifest`, `state` et
`events`, et sur rien d'autre. **Ajouter, modifier ou lire une entrée V4 ne la
fait pas bouger.** C'est un critère de sortie, testable par non-régression
d'empreinte sur un run réel.

## 15.3 Révision V4

Le journal des matériaux porte son propre jeton de fraîcheur, dans un espace de
noms distinct :

```text
evidence_revision      ev-sha256:<64 hex>
```

Elle est calculée **par le contenu** du journal, dans la même fenêtre stable. Une
queue non écrite ne la fait pas varier ; écrire une entrée la change.

Les espaces de noms de révision coexistent et ne se comparent jamais :

```text
sha256:      état opérationnel du run
ctv-sha256:  journal des controverses
ev-sha256:   journal des matériaux
rcn-sha256:  journal de réconciliation
```

Le domaine entre dans l'empreinte elle-même : deux journaux au contenu identique
ne produisent pas le même jeton, et une comparaison croisée ne peut donc pas
réussir par accident.

Une mutation de ce domaine exige la fraîcheur **du journal des matériaux**. Elle
n'exige ni `revision`, ni `controversy_revision` : un tour d'expert ne périme pas
une adduction, et une adduction ne périme pas le run.

Aucune révision n'est reconstruite côté client.

---

# 16. Vérifiabilité

La vérifiabilité est une dimension **déterministe et partielle** : elle ne dit
que ce que CCR a pu constater.

Le domaine expose une **projection déterministe** de vérifiabilité,
bornée à ce que CCR peut réellement constater. Union fermée, par matériau :

```text
HELD_AND_RESOLVABLE     CCR détient une représentation, et elle se relit
HELD_BUT_UNRESOLVABLE   une représentation était attendue et ne se résout pas
                        motif exigé : EVENT_NOT_FOUND | CONTENT_UNAVAILABLE
NOT_OBSERVED_BY_CCR     forme EXTERNAL_REFERENCE — rien n'a jamais été observé
```

Par production portant une citation, une projection
distincte, aux motifs empruntés à V3 sans extension :

```text
RESOLVABLE
UNRESOLVABLE  motif ∈ { MATERIAL_NOT_HELD, CONTENT_UNAVAILABLE, OCCURRENCE_NOT_FOUND }
```

Formalisé, opposable :

```text
UNRESOLVABLE          ≠ FAUX
NOT_OBSERVED_BY_CCR   ≠ FAUX      ≠ ABSENT      ≠ INEXISTANT
UNKNOWN               ≠ FAUX
```

**Aucune valeur `unreliable`, `suspect`, `weak` ou
équivalente n'existe.** La vérifiabilité décrit ce que CCR a pu constater, jamais
une qualité de la pièce.

La vérifiabilité est **dérivée à la lecture**. Elle n'est
jamais persistée sur l'entrée, jamais figée, et ne réécrit jamais l'histoire.

---

# 17. Revalidation déterministe

## 17.1 Précondition de persistance

Une proposition assistée n'est persistée que sous deux conditions conjointes :

```text
MODEL_ASSISTED_PERSISTENCE_PRECONDITION =
    CURRENT_CANONICAL_VALID  AND  BOUND_TO_DISPATCH_INPUT_SET
```

## 17.2 Matrice obligatoire

Les onze contrôles ci-dessous sont **obligatoires** en
phase C. L'ensemble est fermé : aucune implémentation n'en retire ni n'en ajoute
un sans révision du contrat.

| # | Contrôle | Oblig. | Détermin. | Autorité | Ce qu'un succès établit | Ce qu'il n'établit **jamais** |
|---|---|---|---|---|---|---|
| `V1` | `material_id` a la forme canonique | oui | oui | CCR | l'identifiant est bien formé | que le matériau existe |
| `V2` | `material_id` résout dans le journal V4 **du run** | oui | oui | CCR | ce matériau est enregistré ici | qu'il est pertinent |
| `V3` | `target.entry_id` a la forme canonique | oui | oui | CCR | l'identifiant est bien formé | que la cible existe |
| `V4` | `target.entry_id` résout dans le journal V3 **du run** | oui | oui | CCR | la cible est une entrée de ce run | qu'elle est vraie |
| `V5` | la sorte de cible est admise | oui | oui | CCR | la cible est d'une sorte que le contrat sait viser | rien de plus |
| `V6` | `material_id` appartenait à l'ensemble soumis en phase A | oui | oui | CCR | le modèle a réellement vu ce matériau | qu'il l'a bien compris |
| `V7` | `target.entry_id` appartenait à l'ensemble soumis en phase A | oui | oui | CCR | le modèle a réellement vu cette cible | idem |
| `V8` | `orientation` ∈ union fermée | oui | oui | CCR | la valeur est admise | qu'elle est justifiée |
| `V9` | si citation : le matériau est détenu | oui | oui | CCR | une confrontation est possible | rien sur la citation |
| `V10` | si citation : `quoted_text` apparaît exactement au rang `occurrence` | oui | oui | CCR | **la citation existe dans le matériau** | **que la citation appuie la cible** |
| `V11` | aucun doublon exact **à l'intérieur du lot proposé** | oui | oui | CCR | le lot est bien formé | rien sur le monde |

La ligne `V10` porte l'essentiel du contrat : elle établit
`CITATION EXISTS IN MATERIAL`, et **jamais** `CITATION SUPPORTS TARGET`.

**Aucun** contrôle de cette matrice ne peut établir que
`SUPPORTS` est correct, que `OBJECTS_TO` est correct, que le matériau est fiable,
ni que la cible est vraie ou fausse. La revalidation porte sur la **structure**.
L'orientation reste la part assistée par modèle, non validée.

## 17.3 Liaison des entrées

`BINDING AUTHORITY = DERIVATION INPUT AUTHORITY`. Les
contrôles `V6` et `V7` s'exécutent **avant** la validation canonique, et
refusent toute proposition visant un objet qui n'a pas été soumis.

Une entrée ajoutée au run **pendant** l'appel fournisseur
ne devient jamais rétroactivement une entrée soumise. Une proposition qui la vise
est refusée, même si elle est par ailleurs canoniquement valide.

## 17.4 Échec de revalidation

Si **un seul** contrôle obligatoire échoue :

> aucune entrée `ADDUCTION_RECORDED` de `semantic_origin: CCR` n'est écrite.

Sémantique tout-ou-rien sur le lot : la vérification porte
sur **toutes** les propositions avant le premier append. Aucune persistance
partielle.

**Aucun état `PARTIALLY_VALIDATED`, `PENDING_REVIEW`,
`PROVISIONAL` ni équivalent n'existe.** Une proposition non persistée n'a produit
aucun fait canonique.

## 17.5 Quatre issues RENDUES, et ce qu'elles ne couvrent pas

**Portée exacte de cette union.** Les quatre valeurs
ci-dessous décrivent les **retours contrôlés du service lorsqu'un retour
existe**. Elles ne prétendent **pas** couvrir toutes les situations possibles
après `DISPATCH_COMMITTED`.

L'union est fermée et discriminée ; deux issues ne se
confondent jamais :

```text
VALID_ZERO          sortie valide, aucune proposition — SUCCÈS
                    ne dit pas que rien n'appuie ni ne contredit la cible
INVALID_OUTPUT      une réponse a été reçue mais est inexploitable — ÉCHEC
                    motif et position exigés
REVALIDATION_REFUSED une sortie exploitable a échoué à la matrice §17.2 — ÉCHEC
                    contrôle en cause exigé
PROVIDER_FAILED     aucune sortie n'a été rendue — ÉCHEC
```

Dans les quatre cas, l'invocation reste enregistrée au
ledger. Un engagement durable ne s'efface pas parce que la suite a échoué.

## 17.6 Après engagement, sans retour : `UNKNOWN ≠ FAILED`

V2.2 puis V3 l'ont établi : `PROVIDER_FAILED` et
`INVOCATION OUTCOME UNKNOWN` sont deux faits différents.

Un cas existe et n'est couvert par aucune des quatre issues :
`DISPATCH_COMMITTED` est durable, puis le processus est interrompu, tombe, ou
perd la possibilité d'établir ce que le fournisseur a fait. Aucun retour
n'existe alors, et CCR **ne peut pas** affirmer que le fournisseur a échoué.

Il est **interdit** de canoniser cette situation en
`PROVIDER_FAILED`. La fausse équivalence `UNKNOWN = FAILED` affirmerait que rien
n'a été consommé, ce que CCR ignore précisément.

Aucune cinquième valeur de domaine n'est créée, et aucun
statut n'est persisté. L'état se **lit** dans ce qui existe déjà :

```text
engagement présent au ledger        l'invocation a bien été engagée
usage absent ou UNOBSERVED          rien n'a été observé — jamais un zéro
aucune adduction MODEL_ASSISTED     rien n'a été persisté
aucun pending_operation             ce n'est pas une opération de la machine
                                    à états native
aucune Recovery                     le run n'a rien à reprendre
```

Cette lecture est celle du domaine
`INVOCATION_OUTCOME_UNKNOWN` du ledger, et elle n'appartient **pas** au domaine
de reprise du run. Aucune surface ne peut la présenter comme un échec
fournisseur, ni comme un succès, ni comme une consommation nulle.

---

# 18. Chemin en trois phases

Le chemin est en trois phases, **sans dérogation** :

```text
PHASE A   verrou de run COURT
          faits canoniques stables → périmètre → ensemble soumis
          → quota → invocation_id → DISPATCH_COMMITTED durable
          → LIBÉRATION DU VERROU

PHASE B   HORS verrou de run
          un seul appel adaptateur

PHASE C   verrou de run COURT
          relecture canonique → matrice §17.2 → persistance atomique du lot
```

**Aucun verrou de run n'est tenu pendant l'appel
fournisseur.** C'est un critère de sortie, prouvable dynamiquement.

**Aucune reprise, aucun `pending_operation`, aucun état de
Recovery** n'est introduit pour une production probatoire. `pending_operation`
désigne une opération de la machine à états native dont le run doit être repris ;
une demande d'adduction n'en est pas une. L'incertitude de résultat d'une invocation
appartient au domaine `INVOCATION_OUTCOME_UNKNOWN` du ledger, pas au domaine de
reprise du run.

Les faits du moment du dispatch ne sont **jamais** réutilisés
comme s'ils étaient courants : la phase C relit.

---

# 19. Protocole de sortie du modèle

Sortie **versionnée, fermée, minimale** :

```text
adduction_proposal_version   entier, exigé
proposals[]                  liste, éventuellement vide

proposal
  material_id        mat_NNNNNN
  target_entry_id    ctve_NNNNNN
  orientation        NONE | SUPPORTS | OBJECTS_TO
  citation           facultatif — { quoted_text, occurrence }
```

**Toute clé inconnue rend la sortie invalide.** Elle n'est
jamais ignorée. En particulier sont interdits, et leur présence est un
`INVALID_OUTPUT` :

```text
confidence · score · reliability · credibility · weight · strength
sufficiency · truth · probability · winner · closure · quality
provider · model · cost · tokens · usage
```

Motif : ignorer silencieusement un champ de score
affaiblirait le contrat fermé et laisserait croire qu'il a été pris en compte, ou
qu'il pourrait l'être. Le refus est la seule réponse honnête.

`provider`, `model`, `usage` et coût appartiennent aux
autorités d'invocation et d'usage. Ils ne figurent **jamais** dans une charge
sémantique proposée.

Bornes et discipline :

```text
taille maximale de sortie      1 Mio — au-delà, INVALID_OUTPUT
version inconnue               INVALID_OUTPUT
VALID_ZERO                     proposals = [] — issue de SUCCÈS
aucun repair, aucune tolérance, aucune extraction heuristique
aucun second appel, aucune reprise
```

`INVALID_OUTPUT ≠ VALID_ZERO`. La distinction est
**structurelle** : l'union discriminée interdit qu'une sortie invalide s'effondre
en liste vide.

---

# 20. Doublons

## 20.1 Matériaux

Deux enregistrements de matériau portant une représentation
identique sont **deux enregistrements distincts**. Aucun refus, aucune fusion,
aucune idempotence métier.

Motif, tiré du §2.2 : CCR ne possède aucune autorité
d'équivalence. Fusionner deux matériaux parce qu'ils portent les mêmes octets
serait affirmer qu'ils sont le même objet dans le monde, ce que CCR ne sait pas.

**Aucune déduplication sémantique, aucune similarité,
aucune normalisation** de texte, d'URL ou de casse.

## 20.2 Productions

Une production est un **acte historique**. Deux gestes
humains explicites identiques — même matériau, même cible, même orientation, même
origine — produisent **deux faits historiques distincts**.

La règle de doublon exact de V3 n'est **pas** transposée.
Elle protège un journal de faits ; ici, effacer le second geste effacerait
l'information qu'une personne a agi deux fois, ou que deux personnes ont agi.

Une seule exception, et elle porte sur la forme, non sur
l'histoire : **à l'intérieur d'un même lot proposé** par le modèle, deux
propositions identiques rendent la sortie invalide (`V11`). Un lot n'est pas une
succession de gestes ; c'est une seule réponse mal formée.

## 20.3 Idempotence de transport

La sémantique métier ci-dessus est fixée **avant** toute considération de
transport, et prime sur elle.

Les surfaces HTTP et cockpit de mutation **existent** (§30, §31), et l'idempotence
durable s'y applique sans altération : une clé rejouée **rejoue le résultat
enregistré**, elle ne refuse pas et ne crée rien.

Deux distinctions gouvernent ce que le transport peut faire, et aucune n'est un
détail d'affichage :

```text
REGISTER MATERIAL  ≠  ADDUCE MATERIAL
PRÉSENTATION       ≠  AUTORITÉ MÉTIER
```

Une surface qui transporte un geste ne le produit pas, et ne valide rien.

Distinction opposable :

```text
REJEU DE TRANSPORT        même clé d'idempotence  →  le résultat déjà enregistré
SECOND GESTE RÉEL         clé différente          →  un second fait historique
```

Il est **interdit** qu'un mécanisme d'idempotence de
transport efface un second geste réellement distinct.

---

# 21. Suite humaine sur une production assistée

Mécanisme retenu : un humain
exprime sa position en créant **sa propre production**, attribuée `HUMAN`, sans
modifier ni annoter l'inférence CCR.

Motif : cette voie est déjà pleinement expressive — elle
nomme le matériau, la cible et l'orientation, et elle est attribuée. Ajouter un
acte de qualification introduirait un second vocabulaire sans usage observé.

Hors périmètre : un acte humain visant explicitement une production
`MODEL_ASSISTED` est différé, sans dette. S'il était introduit, il resterait un
**nouveau fait attribué HUMAN** et ne pourrait produire aucune valeur du type
`confirmed_truth`, `validated_evidence`, `accepted_as_true`.

Une production humaine ultérieure ne valide jamais
rétroactivement une proposition non persistée, ne la cite pas comme origine, et
ne la rend pas visible.

---

# 22. Append-only et historicité

Une entrée V4 écrite n'est **jamais** réécrite, supprimée,
requalifiée ni marquée. Aucun de ces événements n'y change quoi que ce soit :

```text
le matériau devient indisponible
la source externe change
la cible est contestée
le même matériau est produit avec l'orientation inverse
plus personne ne s'en sert
```

Une production historique **reste vraie comme fait
historique** : cet acteur a bien produit ce matériau ainsi, à cette date.

Ce qui peut changer est de deux natures seulement : un
**nouveau fait** enregistré, ou une **vérifiabilité dérivée à la lecture**.
Jamais l'histoire.

**Aucun cycle de vie n'existe.** Aucun statut, aucune
transition, aucun état courant d'un matériau ou d'une production.

---

# 23. Read model

`EVIDENCE_READ_MODEL_VERSION = 1`, sans rapport avec la
version du journal.

Union **discriminée**, pour qu'un run historique ne puisse
pas porter un zéro :

```text
NOT_AVAILABLE   { read_model_version, availability }
                aucune autre clé — structurellement incapable de porter un compte

AVAILABLE       { read_model_version, availability, evidence_revision,
                  materials[], adductions[],
                  recorded_material_count, recorded_adduction_count }
```

Regroupement : **aucun**. Deux listes plates, dans l'ordre
d'append, ordre serveur. Une production porte ses deux extrémités ; regrouper par
matériau masquerait la cible, et l'inverse masquerait le matériau.

Chaque matériau projeté porte sa **vérifiabilité dérivée**
(§16). Chaque production portant une citation porte sa **résolution dérivée**.

Le frontend **ne peut pas** : reconstruire une production,
recalculer ou inférer une orientation, trier par horodatage, résoudre une
citation, joindre le ledger d'invocation, dériver un compte, ni fusionner deux
matériaux. Le read model est l'autorité de projection.

Une erreur de lecture est une **erreur**. Elle n'est jamais
projetée comme `AVAILABLE` avec zéro élément.

---

# 24. Zéro et absence

Trois faits distincts, jamais confondus :

```text
NOT_AVAILABLE
    la génération du run ne permet pas de regarder — voir §25

AVAILABLE, 0 matériau
    ce run natif n'a enregistré aucun matériau via V4
    ≠ « aucune preuve n'existe dans le monde »

matériau enregistré, 0 production
    CCR détient/identifie un matériau que personne n'a produit au débat via V4
    C'EST le fait que le finding central rendait indicible
```

Deux lectures interdites, et explicitement nommées :

```text
0 production     ≠  les experts sont d'accord
0 production     ≠  le matériau est sans valeur
```

Un journal **absent** et un journal **vide** ne sont pas le
même fait. La distinction est portée par `evidence_revision`, comme V3 la porte
par `controversy_revision`.

---

# 25. Runs existants

Trois cas, traités honnêtement :

```text
LEGACY_V2_EXECUTION      NOT_AVAILABLE
                         le run n'a pas été regardé ; il n'a pas zéro matériau.
                         Structurel : la frontière de mutation native refuse
                         toute mutation V4 avant tout fait durable.

NATIF antérieur à V4     AVAILABLE, 0 matériau, 0 production
                         le journal absent est un état normal, jamais créé
                         par une lecture.

NATIF avec journal V4    AVAILABLE, comptes réels
```

Un run natif antérieur à V4 **peut** recevoir des faits V4
sans migration : la première écriture crée le journal, exactement comme V3 crée
le sien. Aucune conversion, aucune reprise, aucune réécriture.

L'absence d'un journal ne signifie **jamais** l'absence
mondiale de preuves. Aucune surface ne peut l'affirmer.

Hors périmètre : toute migration rétroactive, tout adossement des artefacts
de tour existants à des matériaux.

---

# 26. Références inter-journaux

Une production référence une cible d'un **autre journal du
même run**. Règles :

```text
l'identifiant doit résoudre dans le SNAPSHOT STABLE — jamais par une lecture isolée
aucun ordre total inter-journaux n'est construit — ordre partiel uniquement
aucune suppression historique n'existe, dans aucun des journaux
cible inconnue → refus déterministe, jamais une entrée orpheline tolérée
```

Le contenu de la cible n'est **jamais recopié** dans
l'entrée V4. L'identifiant canonique suffit, et recopier créerait une seconde
vérité capable de diverger.

---

# 27. Concurrence des mutations

Toute mutation V4 suit exactement :

```text
verrou de run
  → snapshot stable
  → fraîcheur V4 attendue vérifiée
  → validation métier
  → champs server-authoritative alloués
  → append
  → révision V4 résultante rendue
```

Deux mutations parties de la même révision V4 : **une seule
aboutit**. La seconde est refusée sur fraîcheur, sans effet.

Un refus ne crée jamais le fichier, ne tronque jamais, ne
répare jamais silencieusement.

Une queue non terminée est normalisée **sous le verrou de
la mutation**, comme en V3, et cette normalisation ne change pas la révision.

---

# 28. Effets fournisseur

Par opération, opposable et testable :

| Opération | `PROVIDER_EFFECT` |
|---|---|
| `registerMaterial` | `EXACT(0)` |
| `adduceMaterial` — production humaine | `EXACT(0)` |
| lecture / read model / projection | `EXACT(0)` |
| toute qualification humaine future | `EXACT(0)` |
| `requestModelAdduction` | `AT_MOST(1)` |

**Une seule** opération V4 peut engager un fournisseur.
Toute autre qui en engagerait un est un défaut, pas une variante.

---

# 29. Disponibilité et validation réelle

Reprise de la discipline V3, sans allègement :

```text
MODEL_ADDUCTION_IMPLEMENTED             la capacité technique existe
MODEL_ADDUCTION_RUNTIME_AVAILABILITY    ce qu'un utilisateur peut déclencher
```

Les deux faits sont **indépendants**. « Implémenté »
n'implique jamais « disponible ».

La disponibilité au runtime reste distincte de l'implémentation : un adaptateur
doublé ne vaut jamais validation fournisseur.

Sa levée est un **changement de code adossé à une preuve citée**. Aucun fichier
de validation, aucune préférence, aucun drapeau mutable, aucun état runtime.

**État courant : l'adduction assistée par modèle est disponible**
([evidence-adducer.ts](../../src/services/evidence-adducer.ts)). `AVAILABLE`
signifie exactement ceci — **un humain peut demander**. Jamais que quelque chose
se déclenche.

Aucune valeur du contrat n'affirme une précision, un
rappel, une exactitude, une qualité ni une validation intellectuelle. Ces
propriétés sont `NOT_TESTED`, définitivement hors périmètre.

---

# 30. Surface publique

Le service métier est **l'unique autorité**. Aucune
surface — CLI, HTTP, cockpit — ne peut contourner ses validations, sa frontière
de mutation, sa gouvernance ni sa fraîcheur.

Surfaces courantes :

```text
enregistrement de matériau       service · CLI · HTTP · cockpit
adduction humaine                service · CLI · HTTP · cockpit
lecture                          read model · cockpit
adduction assistée               service · CLI · HTTP · cockpit, sur geste humain
```

Les écritures passent par `POST /api/runs/:id/evidence`, sur une union fermée
d'opérations ([mutations-http.ts](../../src/cockpit/mutations-http.ts)).

Aucune option de contournement n'existe : ni `--force`, ni `--acceptance`, ni
`--real-test`, ni `--skip-quota`, ni `--skip-ledger`, ni `--bypass`.

Le fournisseur n'est **jamais** un argument : il est celui
que le manifest lie à l'expert du contexte gouverné.

Hors périmètre : toute exigence d'ergonomie, tout écran de composition, tout
assistant.

---

# 31. Cockpit

Le cockpit **lit et écrit** dans ce domaine, sous la même autorité de service que
toute autre surface. Il n'en devient jamais l'autorité de validation :
`REGISTER MATERIAL ≠ ADDUCE MATERIAL` reste une distinction du service, jamais
un affichage.

Peut présenter :

```text
matériaux · forme de représentation · provenance enregistrée
productions · cible · orientation ATTRIBUÉE · origine sémantique
vérifiabilité dérivée · comptes rendus par le serveur
```

**Ne peut pas** présenter :

```text
force · crédibilité · fiabilité · suffisance · score
gagnant · résolu · convergence · preuve préférée · classement
```

Aucune adduction assistée automatique, aucun déclenchement par affichage ou
rafraîchissement : une adduction assistée exige un geste humain explicite, à
chaque fois.

Le cockpit ne trie pas, ne joint pas, ne résout pas, ne
compte pas : il rend ce que le read model lui donne.

---

# 32. Autorité de présentation

`PRESENTATION ≠ BUSINESS AUTHORITY`.

Toute surface doit rendre **immédiatement lisible** la
distinction :

```text
production HUMAN               un humain l'a produite
production CCR MODEL_ASSISTED  CCR l'a inférée, sur demande humaine
```

Une production CCR ne peut **jamais** être présentée comme
si un humain ou un expert l'avait produite. Le marqueur `MODEL_ASSISTED` est
conservé explicitement à toute étape de la projection et du rendu.

Même règle pour le matériau : **source du matériau ≠ acteur
de la production**. Un matériau issu d'un tour d'expert produit par un humain
reste une production humaine.

---

# 33. Sécurité et confiance

**Toute charge V4 est non fiable**, y compris une sortie
fournisseur. Frontières obligatoires :

```text
bornes de taille sur chaque champ — refus, jamais troncature
identifiants canoniques uniquement — aucun chemin, aucun sélecteur libre
aucune traversée de chemin : V4 n'ouvre aucun fichier désigné par un appelant
aucune origine forgée : recorded_by, submitted_by, semantic_origin,
    recorded_at et les identifiants sont server-authoritative
aucune URL active : un localisateur est du TEXTE, jamais un lien cliquable
    ni une ressource chargée
aucun sink HTML : rendu par les primitives sûres V2.3 — lexer, vocabulaire
    fermé, createElement ; jamais innerHTML, jamais de chaîne HTML intermédiaire
aucune image distante, aucune ressource externe automatique
aucun secret : rien n'est lu dans l'environnement, aucun jeton n'est journalisé
aucun fournisseur ni modèle usurpé : ils ne figurent pas dans la charge sémantique
aucune sortie brute de fournisseur traitée comme canonique — elle est
    diagnostique, jamais un fait applicatif
```

Une charge qui prétendrait une autre origine que celle
observée est refusée, pas corrigée.

---

# 34. Exclusions

## 34.1 Classes de preuve CCR

`CURRENT_PROOF_CLASSES_ARE_V4_EVIDENCE_TAXONOMY = NO`.

`REAL_NOW`, `HISTORICAL_REAL_FROZEN`,
`AUTOMATED_REAL_PROCESS`, `FIXTURE`, `STATIC`, `MONITORED`, `NOT_TESTED`
n'apparaissent dans **aucun** champ, valeur, enum ou projection V4.

Elles continuent de qualifier **les preuves que nous avons
sur CCR lui-même**, jamais les matériaux argumentatifs.

## 34.2 Scores

Interdits contractuellement, dans le domaine, le journal,
le read model, la présentation et le protocole modèle :

```text
confidence · evidence_score · weight · strength · credibility
reliability · truth_probability · quality_score · rank · tier
```

Leur présence dans une sortie fournisseur rend celle-ci
invalide (§19). Ils ne sont jamais ignorés en silence.

## 34.3 V5

Hors périmètre : suffisance · poids relatif · préséance · quelle preuve
l'emporte · clôture par accumulation · preuve décisive · résolution du désaccord ·
décision finale fondée sur un ensemble.

V4 **enregistre** deux productions contradictoires sur la
même cible. Il ne choisit pas entre elles, ne les compare pas, ne les compte pas
l'une contre l'autre, et n'en dérive aucun état.

## 34.4 Mission / Stream

Hors périmètre : réutilisation effective inter-run · orchestration de
collecte · file de recherche · mission longue · ordonnancement · propriété d'un
travail probatoire.

## 34.5 Recherche négative

Un fait de recherche négative — « j'ai cherché X sans le trouver » — est un fait
**distinct** d'un matériau et d'une adduction, et le contrat le reconnaît comme
tel :

```text
FAIT DE RECHERCHE NÉGATIVE   distinct par nature
SUPPORT DANS CE DOMAINE      aucun
```

Hors périmètre : ce contrat n'offre aucune façon de l'enregistrer. L'absence de
support est un constat de portée, jamais l'affirmation qu'un tel fait n'aurait
pas de valeur.

## 34.6 Git et reproductibilité

**Aucun contexte Git obligatoire.** Ce domaine n'exécute aucune commande Git et
n'exige ni dépôt, ni branche, ni `HEAD`, ni état propre.

Conséquence à respecter : en l'absence d'une telle provenance, CCR ne peut pas
établir que deux faits ont porté sur le même état de source. Aucune lecture ne
doit laisser croire qu'il le peut, et aucun état de commit n'est fabriqué pour
combler ce silence.

Si une provenance de ce type était un jour réellement
observée par une autre voie, elle pourrait être conservée telle qu'observée.
Absente, elle reste absente. **Aucun commit, aucun état source n'est jamais
inventé.**

Conséquence à respecter : V4 ne peut pas établir qu'un
matériau et une cible se rapportent au même état source. Aucune surface ne peut
l'impliquer.

---

# 35. Matrice de preuve

| Domaine | Classe attendue | Motif |
|---|---|---|
| formes, unions, cardinalités | `STATIC` + `FIXTURE` | pur, déterministe |
| absence de score, de statut, de cycle de vie | `STATIC` | gardes de source |
| identités canoniques, bornes, refus | `FIXTURE` | cas limites construits |
| citation résolue / non résolue | `FIXTURE` | représentations construites |
| append-only, non-mutation, journal absent ≠ vide | `AUTOMATED_REAL_PROCESS` | fichiers réels |
| révision de run inchangée par V4 | `AUTOMATED_REAL_PROCESS` | non-régression d'empreinte |
| `evidence.jsonl` participe au snapshot stable ; l'instabilité de cette source est détectée | `AUTOMATED_REAL_PROCESS` | processus réels |
| ledger v1 / v2 existants restent lisibles | `REAL_NOW` | des runs réels en portent |
| ledger v3 | `FIXTURE` | ledger construit |
| dispatch gouverné en trois phases | `AUTOMATED_REAL_PROCESS` | fournisseur doublé, ledger réel |
| verrou non tenu pendant l'appel | `AUTOMATED_REAL_PROCESS` | observation dynamique |
| adduction assistée de bout en bout | `REAL_NOW` par élément | chaque maillon observé séparément |
| qualité, pertinence, justesse d'une orientation | **`NOT_TESTED`, définitivement hors périmètre** | une invocation ne prouve pas une qualité |

Aucune preuve n'est surclassée. Un fournisseur doublé ne
produit **jamais** un `REAL_NOW`.

---

# 36. Matrice de tests contractuels

Trente-six propriétés que l'implémentation devra établir.
Elles décrivent **ce qui doit être vrai**, jamais comment le vérifier.

| # | Propriété |
|---|---|
| `C1` | un matériau enregistré sans production existe, et le read model le rend avec zéro production |
| `C2` | le même matériau produit deux fois donne **deux** faits historiques, le matériau n'est pas dupliqué |
| `C3` | le même matériau vers deux cibles donne deux productions, un seul matériau |
| `C4` | le même matériau, `SUPPORTS` puis `OBJECTS_TO` par deux humains : les deux coexistent, aucun n'est effacé, aucun n'est préféré |
| `C5` | une production `NONE` est enregistrée et rendue avec sa valeur explicite |
| `C6` | `NONE` n'est jamais projeté, rendu ni interprété comme « sans pertinence », « soutien » ou « objection » |
| `C7` | une production humaine vers un `EXTERNAL_REFERENCE` est admise ; la vérifiabilité rend `NOT_OBSERVED_BY_CCR` ; une citation y est refusée |
| `C8` | une production `MODEL_ASSISTED` d'orientation `NONE` est persistée avec sa dérivation |
| `C9` | idem `SUPPORTS` |
| `C10` | idem `OBJECTS_TO` |
| `C11` | `VALID_ZERO` est un succès, n'écrit aucune production, laisse l'invocation enregistrée, et ne conclut à aucun accord |
| `C12` | une sortie inexploitable est un échec distinct de `VALID_ZERO`, sans écriture ni second appel |
| `C13` | une proposition visant un matériau hors de l'ensemble soumis est refusée |
| `C14` | une proposition visant une cible hors de l'ensemble soumis est refusée |
| `C15` | un matériau ajouté **pendant** l'appel ne devient pas un input rétroactif |
| `C16` | une cible ajoutée **pendant** l'appel ne devient pas un input rétroactif |
| `C17` | une citation exacte est vérifiée et persistée ; le succès n'établit rien sur la pertinence |
| `C18` | une occurrence erronée est refusée, sans écriture partielle |
| `C19` | une citation devenue non résoluble laisse l'entrée historique **intacte** ; seule la projection change |
| `C20` | une panne fournisseur après engagement laisse l'invocation au ledger, n'écrit aucune production, et se distingue d'une sortie invalide |
| `C21` | un quota épuisé refuse **avant** tout engagement : aucun `invocation_id`, aucun appel adaptateur |
| `C22` | une clé d'idempotence rejouée rend le résultat enregistré, sans créer de second fait |
| `C23` | un second geste humain réellement distinct n'est **jamais** effacé comme doublon de transport |
| `C24` | un run legacy rend `NOT_AVAILABLE`, refuse toute mutation V4, et ne crée aucun journal |
| `C25` | un run natif antérieur à V4 rend `AVAILABLE` avec zéro, sans que la lecture crée le journal |
| `C26` | les trois faits du §24 sont distincts et distinguables dans le read model |
| `C27` | une erreur de lecture est une erreur, jamais un `AVAILABLE` à zéro |
| `C28` | la source du matériau n'est jamais projetée comme l'origine sémantique de la production |
| `C29` | une production `MODEL_ASSISTED` n'est jamais présentée comme humaine, à aucune étape |
| `C30` | aucune surface ne dérive « la cible est vraie » d'un `SUPPORTS` |
| `C31` | aucune surface ne dérive « la cible est fausse » d'un `OBJECTS_TO` |
| `C32` | aucun champ de score n'existe dans le domaine, le journal, le read model ni le protocole ; une sortie en portant un est invalide |
| `C33` | aucune préséance, aucune agrégation, aucune clôture n'est calculée entre deux productions contradictoires |
| `C34` | aucun tour natif, aucune lecture, aucun rafraîchissement ne déclenche une production assistée |
| `C35` | les quatre opérations à zéro fournisseur n'approchent aucun adaptateur |
| `C36` | des enregistrements de ledger v1 et v2 restent lisibles après l'introduction de la version 3 ; aucun n'est réécrit |

---

# 37. Surfaces d'attaque et ce qui les repousse

Seize façons de faire dire à ce domaine plus qu'il ne sait, et la règle qui
s'y oppose dans chaque cas.

| # | Attaque | Ce qui la repousse |
|---|---|---|
| `A` | un simple matériau devient une production cachée | §1.1 interdit la production comme propriété du matériau ; `C1` l'établit |
| `B` | une orientation devient un verdict | §7, `C30`, `C31` |
| `C` | le fournisseur forge l'origine | §10.2 et §33 : origine et identifiants server-authoritative ; le fournisseur n'apparaît pas dans la charge |
| `D` | le fournisseur vise un objet non soumis | `V6`, `V7`, `C13`–`C16` |
| `E` | une source externe mutable présentée comme stable | §12.2 : aucune demande assistée sur un matériau non détenu ; §11.3 conserve l'adduction humaine |
| `F` | une citation présente présentée comme pertinente | `V10` énonce les deux membres ; `C17` l'établit |
| `G` | une production `MODEL_ASSISTED` présentée comme humaine | §32, `C29` |
| `H` | une garde de doublon supprime un second geste humain | §20.2, §20.3, `C23` |
| `I` | une URL enregistrée présentée comme contenu observé | §3.2, `NOT_OBSERVED_BY_CCR`, `C7` |
| `J` | un vieux run sans journal présenté mensongèrement | §25, `C24`, `C25` |
| `K` | les classes de preuve CCR contaminent le matériau | §34.1 |
| `L` | la suffisance fuit depuis V5 | §34.3, `C33` |
| `M` | une dépendance à l'état Git réintroduit une autorité que CCR n'a pas | §34.6 |
| `N` | un verrou est tenu pendant l'appel fournisseur | §18, critère de sortie prouvable |
| `O` | un nouveau déclencheur casse les lecteurs historiques | §13 : version de ledger propre, refus ligne par ligne |
| `P` | un statut de cycle de vie apparaît implicitement | §9 et §22 : aucun champ d'état, aucune transition |

Aucune de ces seize entrées n'est une garantie de qualité intellectuelle. Elles
disent seulement ce que le domaine refuse de représenter.

---

# 38. Ce que ce contrat ne couvre pas

Deux extensions **exigeraient une décision humaine**, et sont nommées pour
qu'aucune lecture ne les prenne pour des omissions :

```text
origine sémantique SOURCE       un expert produisant lui-même une pièce
origine CCR déterministe        une adduction CCR sans appel modèle
```

Aucune des deux n'est préparée par un champ spéculatif (§10.1).

Le contrat ne dit rien, et ne dira rien, de la **suffisance** d'un matériau, de
son poids relatif, de sa préséance sur un autre, ni de la question de savoir
quelle pièce emporte un débat. Ces propriétés sont hors périmètre, définitivement.
