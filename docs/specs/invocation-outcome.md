# CCR — Spécification · Projection des issues d'invocation

```text
STATUT                      contrat courant
PORTÉE                      contrat de projection publique · lecture seule
CONTRAT SÉMANTIQUE          version 1
VERSIONS D'ENREGISTREMENT   1 · 2
```

Ce document définit ce que la commande `ccr invocation-outcomes` rend
publiquement, et ce qu'un opérateur a le droit d'en conclure.

---

# 1. Autorité et portée

## 1.1 Ce que ce document possède

Ce document est le **point d'entrée normatif** de la projection des issues
d'invocation. Il possède les sémantiques **propres à la projection** : ce qui est
rendu, sous quelle forme, dans quel ordre, et ce qu'une réponse autorise ou
interdit de conclure.

Il n'est pas une autorité sémantique autosuffisante.

```text
DOCTRINE          invariants transverses — dont VALID_ZERO
SPÉCIFICATIONS    sémantiques de leur domaine propre
CE DOCUMENT       sémantiques publiques propres à la projection
README · AIDE     orientation et découverte, jamais autorité normative
EXEMPLES          illustration et preuve, jamais contrat
CODE · TESTS      preuve d'implémentation, jamais contrat public
```

Aucune définition possédée ailleurs n'est recopiée ici. Là où une sémantique
appartient à la doctrine ou à un domaine, ce document **renvoie** et ne
redéfinit pas.

## 1.2 Version du contrat sémantique

```text
CONTRAT SÉMANTIQUE          version 1
VERSIONS D'ENREGISTREMENT SUPPORTÉES   1 · 2
```

Trois versions distinctes ne doivent pas être confondues :

```text
version du contrat sémantique   ce document, et ce qu'il fait dire aux valeurs
schema_version d'enregistrement contexte historique de l'enregistrement lu
version du paquet CCR           la distribution installée
```

La version du contrat sémantique n'apparaît ni dans la sortie de la commande, ni
dans la persistance. Elle est déclarée ici, et ici seulement.

Le mécanisme d'évolution d'un contrat 1 vers un contrat 2 **n'est pas décidé par
ce document**.

---

# 2. Modèle de la projection

```text
OBJET PROJETÉ    les faits d'issue d'invocation dédiés déjà persistés
CENTRAGE         sur le fait, jamais sur l'invocation
LECTURE          seule — la commande n'écrit rien
SOURCES LUES     une seule
```

La projection **énumère les enregistrements qui existent**. Elle n'énumère
jamais les invocations qui pourraient en porter un. Une invocation sans fait
dédié ne produit aucune ligne, et l'absence de ligne n'est pas une propriété de
cette invocation.

Ce qu'elle n'est pas :

```text
≠ vue d'état des invocations
≠ modèle générique de statut d'invocation
≠ agrégation inter-autorités
≠ autorité générique de succès
```

Un succès qui produit son objet de domaine reste attesté par cet objet, et non
par ce journal. C'est la raison d'être du centrage sur le fait : la source ne
porte que les issues terminales **qu'aucun fait de domaine durable n'atteste
lui-même**.

Aucune autre autorité n'est interrogée — ni registre d'engagement, ni transcript
natif, ni observations d'usage, ni objet de domaine.

---

# 3. Métadonnées d'enregistrement

## 3.1 `invocation_id`

Identifie l'invocation CCR à laquelle le fait dédié est attaché.

Ce document ne contractualise rien d'autre à son sujet : ni son rôle d'index, ni
son format lexical, ni son unicité au sein d'une autre autorité.

## 3.2 `recorded_at`

Instant auquel CCR a enregistré ce fait.

C'est un horodatage d'**enregistrement**, pas d'exécution : il ne date ni l'appel
au fournisseur, ni la production de la sortie refusée, ni l'engagement de
l'invocation.

## 3.3 `enregistrement vN`

Rend la version sous laquelle **cet enregistrement-là** a été persisté.

```text
enregistrement vN  =  contexte historique d'interprétation
                   ≠  version du contrat sémantique
                   ≠  version du paquet CCR
```

Un enregistrement conserve sa version d'origine. Il n'est jamais réestampillé
parce qu'un fait plus récent s'ajoute à côté de lui, et la forme sous laquelle il
a été écrit reste lisible tant que sa version figure parmi les versions
supportées déclarées au § 1.2.

---

# 4. Genres d'issue

La projection rend aujourd'hui dix genres. Chacun est rendu sous **son code
exact**.

## 4.1 `VALID_ZERO`

```text
DÉFINITION  →  docs/doctrine.md § 17.7
```

La définition de `VALID_ZERO` et ses non-affirmations appartiennent à la
doctrine. Ce document ne les redéfinit pas et ne les reformule pas.

Ce que ce document possède est son **rôle de projection** : `VALID_ZERO` est
rendu sous son code exact, accompagné de sa seule glose de cardinalité. Aucune
paraphrase ne le remplace, et la glose n'ajoute rien à la définition doctrinale.

## 4.2 Genres négatifs

Neuf genres, groupés par famille d'opération d'origine.

| Genre | Signification bornée |
|---|---|
| `V3_INVALID_OUTPUT` | une détection V3 a reçu une sortie de modèle que le contrat V3 refuse ; aucune relation n'a été écrite |
| `V3_PROVIDER_FAILED` | une détection V3 engagée n'a pas abouti côté fournisseur ou processus |
| `V4_INVALID_OUTPUT` | une adduction assistée V4 a reçu une sortie que le contrat V4 refuse |
| `V4_REVALIDATION_REFUSED` | une sortie V4 lisible a été refusée par une revalidation sous verrou |
| `V4_PROVIDER_FAILED` | une adduction assistée V4 engagée n'a pas abouti côté fournisseur ou processus |
| `V5_INVALID_OUTPUT` | une proposition assistée V5 a reçu une sortie que le contrat V5 refuse |
| `V5_REVALIDATION_REFUSED` | une sortie V5 lisible a été refusée par une revalidation sous verrou |
| `V5_PROVIDER_FAILED` | une proposition assistée V5 engagée n'a pas abouti côté fournisseur ou processus |
| `NATIVE_PROCESS_FAILED` | un tour natif engagé — `start`, `send`, `step`, reprise — n'a pas abouti |

Ce que ces genres établissent, et ce qu'ils n'établissent pas :

```text
ÉTABLI          l'opération nommée a été engagée, et s'est terminée ainsi
NON ÉTABLI      qu'un expert avait tort
NON ÉTABLI      qu'une position est fausse
NON ÉTABLI      qu'un désaccord existe ou n'existe pas
NON ÉTABLI      qu'une autre invocation a réussi ou échoué
```

**Les préfixes sont porteurs de sens.** `V3_INVALID_OUTPUT` n'est pas le jeton
`INVALID_OUTPUT` que telle spécification de domaine emploie pour décrire l'issue
d'une opération. Ces vocabulaires sont distincts, et ce document n'en établit
aucune équivalence. Pour ce que l'opération sous-jacente signifie, la
spécification du domaine concerné fait foi :

```text
V3  →  docs/specs/controversy.md
V4  →  docs/specs/evidence.md
V5  →  docs/specs/reconciliation.md
```

---

# 5. Motifs et charges utiles typées

## 5.1 Trois vocabulaires, jamais fusionnés

Les familles V3, V4 et V5 portent trois vocabulaires de motif **distincts**,
comptant respectivement 5, 6 et 15 valeurs. Des libellés identiques d'une famille
à l'autre ne désignent pas le même fait, et ce document n'autorise aucune table
unifiée.

## 5.2 Motifs V3 — `V3_INVALID_OUTPUT`

| Motif | Signification bornée |
|---|---|
| `OUTPUT_TOO_LARGE` | la sortie dépassait la borne acceptée ; aucune conclusion fiable sur son contenu n'est établie par cette issue |
| `INVALID_JSON` | la sortie n'était pas du JSON lisible |
| `UNSUPPORTED_OUTPUT_VERSION` | la sortie déclarait une version que le contrat V3 n'accepte pas |
| `INVALID_OUTPUT_SHAPE` | la sortie était lisible mais sa forme d'enveloppe est refusée |
| `INVALID_PROPOSAL` | l'enveloppe était lisible, mais une proposition qu'elle porte ne satisfait pas le contrat V3 |

## 5.3 Motifs V4 — `V4_INVALID_OUTPUT`

Six motifs, chacun interprétable directement dans le contexte V4. Cinq portent le
même libellé qu'un motif V3 : ce sont **des motifs distincts**, appartenant au
vocabulaire V4, et la coïncidence de libellé n'en fait pas le même fait.

| Motif | Signification bornée |
|---|---|
| `OUTPUT_TOO_LARGE` | la sortie dépassait la borne acceptée ; aucune conclusion fiable sur son contenu n'est établie par cette issue |
| `INVALID_JSON` | la sortie n'était pas du JSON lisible |
| `UNSUPPORTED_OUTPUT_VERSION` | la sortie déclarait une version que le contrat V4 n'accepte pas |
| `INVALID_OUTPUT_SHAPE` | la sortie était lisible mais sa forme d'enveloppe est refusée par le contrat V4 |
| `INVALID_PROPOSAL` | l'enveloppe était lisible, mais une proposition qu'elle porte ne satisfait pas le contrat V4 |
| `DUPLICATE_PROPOSAL` | la sortie portait deux fois la même proposition |

## 5.4 Motifs V5 — `V5_INVALID_OUTPUT`

| Motif | Signification bornée |
|---|---|
| `OUTPUT_TOO_LARGE` | la sortie dépassait la borne acceptée ; aucune conclusion fiable sur son contenu n'est établie par cette issue |
| `OUTPUT_UNPARSABLE` | le JSON demandé au modèle n'a pas pu être lu |
| `UNSUPPORTED_VERSION` | la sortie déclarait une version que le contrat V5 n'accepte pas |
| `INVALID_ENVELOPE` | la forme d'enveloppe de la sortie est refusée |
| `INVALID_PROPOSAL` | une proposition portée ne satisfait pas le contrat V5 |
| `DUPLICATE_PROPOSAL` | la sortie portait deux fois la même proposition |
| `UNKNOWN_TARGET` | une proposition visait une cible qui n'existe pas dans ce run |
| `INVALID_SCOPE` | le périmètre déclaré par une proposition est refusé |
| `RANKED_OPTIONS` | la sortie portait un marqueur de classement — CCR ne désigne aucun vainqueur |
| `SCORE_FIELD_PRESENT` | la sortie portait un champ de mérite — la seule présence est un refus |
| `CLOSURE_CLAIMED` | la sortie revendiquait une clôture — la clôture est un acte humain |
| `CLOSURE_WITHDRAWAL_CLAIMED` | la sortie revendiquait le retrait d'une clôture |
| `SUPERSESSION_CLAIMED` | la sortie revendiquait une supersession |
| `HUMAN_DECISION_CLAIMED` | la sortie revendiquait une décision humaine |
| `AUTHORITATIVE_EFFECT_CLAIMED` | la sortie revendiquait un effet faisant autorité |

Les six derniers motifs ne décrivent pas une malformation : ils nomment une
**revendication d'autorité** que CCR refuse par principe, indépendamment de la
qualité du reste de la sortie.

## 5.5 Contrôles de revalidation

### V5 — `V5_REVALIDATION_REFUSED`

Vocabulaire fermé, quatre valeurs :

| Contrôle | Signification bornée |
|---|---|
| `R0` | la révision autoritaire relue pour la revalidation ne correspondait plus à la référence attendue |
| `SCOPE` | le périmètre proposé a été refusé à la revalidation |
| `SUBMITTED_SET` | un objet nommé n'appartient pas à l'ensemble soumis à l'étape précédente |
| `CANONICAL_FORM` | la validation canonique a refusé |

### V4 — `V4_REVALIDATION_REFUSED`

Le champ `check` de la famille V4 est **une chaîne libre**, non un vocabulaire
fermé. Sa valeur nomme le contrôle qui a refusé, dans les termes de l'opération
V4 d'origine.

Cette asymétrie avec V5 est le comportement courant, et elle est déclarée ici
pour qu'un opérateur ne l'interprète pas comme une valeur d'un vocabulaire fermé.

## 5.6 Champs de charge utile

| Champ | Rôle sémantique pour l'opérateur |
|---|---|
| `reason` | le motif nommé du refus, dans le vocabulaire de sa famille |
| `at` | le localisateur, dans la sortie refusée, de l'endroit où le refus a été prononcé |
| `check` | le contrôle de revalidation qui a refusé |
| `detail` | la précision textuelle accompagnant un refus de revalidation |
| `error_code` | le code d'erreur CCR de l'échec, **lorsqu'il en existe un de significatif** |
| `native_detail` | la précision typée d'un échec natif que CCR a lui-même établi |

**L'absence d'`error_code` a un sens exact** : CCR ne connaît pas de code natif
significatif pour cet échec. Elle ne signifie pas que l'échec n'a pas eu lieu, et
aucun code de repli ne vient combler ce vide — une ignorance déclarée vaut mieux
qu'un diagnostic inventé.

## 5.7 `native_detail`

Présent uniquement pour `NATIVE_PROCESS_FAILED`, et uniquement pour les deux
échecs que **CCR construit lui-même**. Il précise le fait natif sans jamais le
reclasser : le genre de premier niveau reste `NATIVE_PROCESS_FAILED`.

| Code | Signification bornée |
|---|---|
| `SESSION_ID_COLLISION` | le fournisseur a rendu une session déjà liée à l'autre expert |
| `AGENT_SESSION_MISMATCH` | la réponse est arrivée sous une session autre que celle reprise |

Sous-champs rendus :

| Sous-champ | Rôle |
|---|---|
| `code` | le code ci-dessus |
| `expert_slot` | le rôle d'expert concerné |
| `provider` | le moteur lié à ce rôle |
| `session_id` | la session en collision — `SESSION_ID_COLLISION` |
| `expected_session_id` | la session que CCR reprenait — `AGENT_SESSION_MISMATCH` |
| `found_session_id` | la session sous laquelle la réponse est arrivée — `AGENT_SESSION_MISMATCH` |

Les échecs levés par un adaptateur fournisseur ne portent **pas** de
`native_detail` : leur matériau de diagnostic appartient au transcript natif, pas
à cette source.

---

# 6. Présentation de l'autorité et de la source

## 6.1 Ligne d'autorité

Elle déclare la nature de ce que la commande rend :

```text
fait durable d'issue d'invocation
  ≠  décision humaine
  ≠  autorité d'objet de domaine
  ≠  résultat terminal générique
```

## 6.2 Ligne de source

Elle identifie la **persistance dédiée des issues d'invocation** dont la
projection provient, et n'est rendue que lorsqu'au moins un fait existe.

Le nom de fichier physique employé aujourd'hui est un **détail de présentation et
d'implémentation**. Ce document ne le contractualise pas comme interface de
stockage pérenne.

---

# 7. Sémantiques de requête

```text
REQUÊTE DE RUN      tous les faits dédiés du run
FILTRE              --invocation restreint ce même ensemble
ORDRE               ordre d'ajout persisté
```

## 7.1 Filtre

Le filtre porte sur l'ensemble des faits, et **rien d'autre**. Il n'interroge
aucune autre autorité pour décider si l'identifiant existe ailleurs.

## 7.2 Zéro correspondance

Une requête aboutie sans correspondance signifie exactement :

```text
aucun fait dédié d'issue d'invocation n'est enregistré pour cette requête
```

Elle ne signifie pas :

```text
≠ succès
≠ échec
≠ VALID_ZERO
≠ invocation inconnue
≠ le résultat est connu ailleurs
≠ le résultat est inconnu ailleurs
≠ un état d'invocation synthétique quelconque
```

Zéro correspondance est une **cardinalité**, jamais un verdict. Une lecture
aboutie qui ne trouve rien est une réussite de lecture.

## 7.3 Ordre

L'ordre rendu est l'ordre d'ajout persisté. Aucun tri n'est appliqué — ni par
identifiant, ni par gravité, ni par date. Trier par gravité serait rendre un
jugement.

---

# 8. Sémantiques de lecture et d'erreur

## 8.1 La distinction fondatrice

```text
LECTURE ABOUTIE, ZÉRO FAIT
  ≠
LECTURE QUI N'A PAS PU ÊTRE MENÉE DE FAÇON FIABLE
```

Les deux doivent rester distinguables par l'opérateur. Confondre l'une avec
l'autre transformerait une panne en absence.

## 8.2 Principe de refus fermé

Une sémantique non supportée ou non interprétable **ne doit jamais** :

```text
être devinée
être coercée silencieusement
devenir une absence de correspondance
devenir un fait de succès ou d'échec connu
être rendue comme si elle avait été interprétée de façon fiable
```

Ce principe est contractuel.

## 8.3 Ce qui n'est pas contractualisé ici

L'implémentation courante refuse la **lecture entière** lorsqu'un enregistrement
porte une version ou une forme qu'elle n'accepte pas.

```text
REFUS DE LA LECTURE ENTIÈRE   comportement d'implémentation courant
GRANULARITÉ FUTURE DU REFUS   non contractualisée par ce document
```

Un opérateur peut compter sur le principe du § 8.2. Il ne peut pas compter sur le
fait qu'un futur CCR refusera exactement au même grain.

---

# 9. Stabilité et évolution

## 9.1 Ce qui est promis

```text
MÊME JETON PUBLIC
+ MÊME CONTRAT SÉMANTIQUE APPLICABLE
    →  MÊME SIGNIFICATION BORNÉE
```

Aucune réaffectation sémantique silencieuse. Aucune réinterprétation historique
silencieuse.

Les genres d'issue, les motifs et les noms de champ contractuels de ce document
sont des **identifiants stables au sein du contrat sémantique applicable et des
versions d'enregistrement supportées déclarées au § 1.2**.

Ce n'est pas une garantie perpétuelle valable pour toute version future de CCR.

## 9.2 Implémentation et frontière sémantique

Le rôle sémantique public est stable sous le contrat applicable. L'implémentation
interne peut évoluer tant qu'elle préserve cette frontière.

## 9.3 Enregistrements historiques

```text
JAMAIS réestampillés en silence
JAMAIS réinterprétés sémantiquement en silence
```

La fidélité sémantique arrière est requise **tant que le contrat historique
concerné reste supporté**. Un support historique infini n'est pas promis.

## 9.4 Ce qui exige une évolution explicite du contrat

```text
nouveau jeton contractuel
retrait d'un jeton
renommage
réaffectation sémantique matérielle
```

Le mécanisme exact d'évolution n'est pas choisi par ce document.

## 9.5 Ce qui n'est pas une interface

```text
prose exacte de la CLI      présentation
espacement · alignement     présentation
libellés de pointeur        présentation
```

Ces éléments ne constituent aucune interface sémantique.

---

# 10. Références d'autorité

| Sujet | Autorité |
|---|---|
| `VALID_ZERO` | [`docs/doctrine.md`](../doctrine.md) § 17.7 |
| Invariants transverses | [`docs/doctrine.md`](../doctrine.md) |
| Sémantiques de la détection V3 | [`docs/specs/controversy.md`](controversy.md) |
| Sémantiques des matériaux et adductions V4 | [`docs/specs/evidence.md`](evidence.md) |
| Sémantiques de la réconciliation V5 | [`docs/specs/reconciliation.md`](reconciliation.md) |
| Invocation, usage, coût, quota | [`docs/doctrine.md`](../doctrine.md) § 13 |
| Engagement d'invocation dans le domaine V4 | [`docs/specs/evidence.md`](evidence.md) — référence contextuelle |

---

**Une issue d'invocation est une observation de procédure CCR.** Elle ne dit rien
de la valeur d'une position, ne désigne aucun vainqueur, et ne confère aucune
autorité — ni à un expert, ni à un modèle, ni à CCR lui-même.
