# CCR — Spécification · Réconciliation

```text
STATUT   contrat courant
PORTÉE   contrat métier · local à un run
```

Ce document définit ce que CCR peut lire, proposer et enregistrer d'un désaccord —
et ce qu'aucun de ces actes n'établit.

---

# 1. Statut et portée

Il décrit le **contrat courant**, avec la précision nécessaire pour contribuer.
Il ne remplace pas la doctrine : pour ce que CCR affirme et refuse d'affirmer,
voir [`../doctrine.md`](../doctrine.md).

Sa portée est **run-locale**. Aucune identité, aucun effet et aucune actualité
n'y franchit la frontière d'un run.

---

# 2. Mission contractuelle

## 2.1 Quatre capacités et un effet humain conditionnel

```text
A  STRUCTURED READING        lecture dérivée de l'état du désaccord
B  HUMAN RECONCILIATION ACT  acte humain sur un périmètre explicite
C  CCR RECONCILIATION        proposition attribuée à CCR, sans effet autonome
   PROPOSAL
D  STRUCTURAL DETECTION      prédicat déterministe sur des faits structurels
G  SUBSTANTIVE CLOSURE       effet explicite d'un acte humain, sur un périmètre
                             explicitement borné
```

```text
A  ≠  B  ≠  C  ≠  D  ≠  G
```

Cinq notions distinctes : **quatre capacités**, et un **effet humain
conditionnel**. `G` n'est pas une capacité autonome — il n'existe qu'attaché
à `B`.

## 2.2 Non-équivalences fondatrices

```text
PROPOSAL      ≠  DECISION
DETECTION     ≠  REMEDIATION
DERIVED VIEW  ≠  HISTORICAL ACT
CLOSURE       ≠  TRUTH
CLOSURE       ≠  CONVERGED
CLOSURE       ≠  EXPERT AGREEMENT
```

Et :

```text
SUPERSESSION OF DECISION  ≠  SUPERSESSION OF CLOSURE EFFECT
DECISION CURRENTNESS      ≠  CLOSURE-EFFECT CURRENTNESS
```

## 2.3 Ce que le moteur n'établit jamais

```text
la vérité d'un énoncé          un gagnant           une preuve préférée
la fiabilité d'un élément      un classement        une probabilité de vérité
la suffisance probatoire       un poids             une convergence
```

---

# 3. Objets canoniques

## 3.1 Objets persistés — trois

| Sorte | Origine | Effets possibles |
|---|---|---|
| `RECONCILIATION_PROPOSED` | `CCR` | **aucun** |
| `RECONCILIATION_RECORDED` | `HUMAN` | clôture · retrait de clôture · supersession |
| `PROPOSAL_RESPONSE_RECORDED` | `HUMAN` | **aucun** |

**Une seule forme d'acte humain autoritaire.** `RECONCILIATION_RECORDED`
est le **seul** objet pouvant porter un effet autoritaire V5. Aucune forme allégée
n'existe.

## 3.2 Objets dérivés — jamais persistés

```text
STRUCTURED_READING           la lecture organisée (A)
DECISION_CURRENTNESS         quels actes humains sont courants comme décisions
CLOSURE_EFFECT_CURRENTNESS   quels effets de clôture sont courants, par unité
DERIVED_DISAGREEMENT_VIEW    les signaux explicites de désaccord observables
STRUCTURAL_DETECTIONS        les prédicats de D
```

**Deux dérivations d'actualité, indépendantes.** Aucune ne se déduit de l'autre.

## 3.3 Pourquoi la détection n'est pas persistée

`D` est un prédicat déterministe sur l'instantané autoritaire. Le persister
créerait un fait qui peut périmer, et qu'un lecteur prendrait pour un constat tenu
par CCR. Aucune détection n'est persistée.

## 3.4 Interdit de fusion

Aucun objet ne réunit sous un même champ :

```text
decision currentness  ·  closure effect  ·  disagreement  ·  convergence
```

---

# 4. Identité

```text
rcn_NNNNNN        NNNNNN = séquence décimale, six chiffres au moins
```

Espace disjoint de `evt_`, `ctv_`, `ctve_`, `mat_`, `add_`, `dec_`.

```text
UNICITÉ        séquence strictement croissante par run
IMMUTABILITÉ   une identité attribuée ne change jamais
CRÉATION       attribuée par le serveur, sous le verrou de run
CANONICITÉ     format(parse(id)) === id — refus sinon
RÉFÉRENCE      par identité, jamais par position, rang ou date
```

```text
IDENTITY ORDER  ≠  PRIORITY  ≠  MERITS  ≠  CURRENTNESS
```

Le format exact est **local à ce contrat** : `rcn_` suivi d'au moins six
chiffres décimaux, la séquence étant complétée à gauche par des zéros. Aucune
lecture ne dérive de sens de sa forme, et aucun appelant ne la forge.

---

# 5. Cible canonique

```text
CANONICAL_RECONCILIATION_TARGET = CONTROVERSY  ctv_
MULTI_TARGET_UNION              = NO
```

Chaque acte V5 est rattaché à **exactement une** controverse.

Référençables sans être cibles : `ctve_` (unité de périmètre et ancrage), `add_`,
`mat_`, `dec_`, `evt_`, `rcn_`.

**Non-réécriture de V3 et V4.**

```text
V4 TARGET SEMANTICS   et   V5 TARGET SEMANTICS   restent DISTINCTES
```

---

# 6. Périmètre

## 6.1 Règles

```text
SCOPE_REQUIRED        = YES        sur tout enregistrement PORTEUR d'un périmètre
ABSENT_SCOPE          = INVALID
EMPTY_SCOPE           = INVALID
CANONICAL_SCOPE_UNIT  = ctve_
```

Portent un périmètre, et eux seuls :

```text
RECONCILIATION_RECORDED       l'acte, et chaque relation ou effet qu'il porte
RECONCILIATION_PROPOSED       la proposition
```

`PROPOSAL_RESPONSE_RECORDED` **ne porte aucun périmètre** : il ne gouverne rien
(§13.1). Un champ de périmètre y serait sans sémantique, et offrirait une prise à
la fuite d'autorité que §13.5 interdit.

**Aucun héritage de périmètre n'existe.** Chaque acte, et chaque relation ou effet
qu'il porte, déclare le sien.

## 6.2 Représentation

```text
scope_kind   SUBSET | WHOLE
scope        [ ctve_…, … ]        énumération, non vide, sans doublon
```

L'énumération gouverne. Le marqueur enregistre l'intention et ne gouverne rien.

## 6.3 Sémantique de `WHOLE`

```text
WHOLE = l'ensemble des ctve_ de la controverse cible, tel qu'observé dans
        l'instantané autoritaire sur lequel l'acte est validé, énuméré et
        enregistré sous le verrou à ce moment
```

Une `ctve_` créée après l'acte n'est **jamais** rétroactivement couverte.

**Démonstration.** Un effet ne porte que sur les unités énumérées du périmètre qui
le déclare. L'énumération est fixée à la validation et immuable. Une entrée absente
de toute énumération n'est couverte par aucun effet. Aucune règle de ce contrat ne
produit d'effet sur une unité non énumérée.

`WHOLE` ne peut être représenté ni par l'absence de périmètre, ni par un périmètre
vide, ni par convention implicite.

## 6.4 Validation d'appartenance

```text
1  identité canonique
2  l'entrée existe dans l'instantané autoritaire de l'acte
3  l'entrée appartient à la controverse cible
4  aucun doublon dans l'énumération
```

Un échec fait **refuser l'acte entier**, jamais retenir un périmètre partiel.

## 6.5 Controverse sans entrée

Constat d'intégration, non doctrine :

```text
CURRENT V3 INTEGRATION FACT
    dans le modèle V3 actuel, une controverse canonique observable est portée
    par au moins une ctve_ ; le journal V3 est append-only et aucune entrée
    n'en est retirée
```

`EMPTY_SCOPE = INVALID` ne rend donc aujourd'hui aucune controverse canonique
impossible à réconcilier, et `WHOLE` n'est jamais vide en pratique. Si le modèle
V3 évoluait, cette hypothèse devrait être réévaluée.

---

# 7. Origine sémantique et attribution

```text
SEMANTIC_ORIGIN = HUMAN | CCR
```

Union fermée **du présent contrat**, non transversale.

```text
DERIVATION_METHOD = DETERMINISTIC | MODEL_ASSISTED     requis ⟺ origine CCR
```

```text
DERIVATION         ≠  SEMANTIC_ORIGIN
PROVIDER           ≠  SEMANTIC_ORIGIN
RECORDER           ≠  SEMANTIC_ORIGIN
TECHNICAL EXECUTOR ≠  SEMANTIC_ORIGIN
```

Sept dimensions tenues distinctes : qui accomplit · origine sémantique · qui
enregistre · exécutant technique · provenance · attribution d'énoncé · dérivation.
Fournisseur et modèle sont retrouvables par `invocation_id` ; ils n'apparaissent
jamais comme auteur.

---

# 8. `A` — lecture structurée

Vue **dérivée**, calculée depuis l'instantané autoritaire. Elle n'écrit rien.

## 8.1 Champs dérivés autorisés — liste fermée

```text
A01  actes V5 du run, par controverse, dans l'ordre d'append
A02  identité, sorte, origine sémantique, dérivation
A03  cible, scope_kind, périmètre énuméré
A04  contenu attribué
A05  déclarations de clôture, avec leur périmètre
A06  déclarations de retrait de clôture, avec leur périmètre et leurs cibles
A07  relations de supersession, avec leur périmètre propre
A08  relation à une proposition, si présente
A09  DECISION_CURRENTNESS — par acte et par unité (§20)
A10  CLOSURE_EFFECT_CURRENTNESS — par unité (§21)
A11  DERIVED_DISAGREEMENT_VIEW (§22)
A12  STRUCTURAL_DETECTIONS (§14)
A13  révision du journal V5
A14  provenance et attribution
```

## 8.2 Ce que `A` ne peut pas faire

```text
créer un acte historique          inférer une clôture
créer une décision                inférer un retrait de clôture
choisir un gagnant                inférer une supersession
déclarer une vérité               définir CONVERGED
trier par préférence              attribuer un poids
agréger en un statut unique       déduire une actualité d'effet depuis
                                  une actualité de décision
```

## 8.3 Ordre

Ordre d'append du journal, seul ordre autoritaire. Aucune reconstruction côté
client.

```text
ORDER ≠ PREFERENCE
```

---

# 9. `B` — acte humain de réconciliation

## 9.1 Forme

```text
RECONCILIATION_RECORDED
  schema_version        version du journal V5
  entry_id              rcn_NNNNNN
  kind                  'RECONCILIATION_RECORDED'
  target                { kind: 'CONTROVERSY', controversy_id: ctv_… }
  scope_kind            SUBSET | WHOLE
  scope                 [ ctve_… ]                    non vide
  semantic_origin       'HUMAN'                       obligatoire
  recorded_by           'CCR'                         le scribe
  recorded_at           horodatage d'enregistrement
  content               contenu humain attribué, texte borné — OBLIGATOIRE
  provenance            référence documentaire (§10.4) — OBLIGATOIRE
  closure               effet de clôture explicite, optionnel (§16)
  closure_withdrawal    retrait de clôture explicite, optionnel (§21.3)
  supersedes            relations de supersession, optionnel (§18)
  responds_to           { proposal_id, relation, adopted_option_id? }, optionnel
  observed_revision     révision autoritaire de validation (§32)
```

## 9.2 Contraintes

```text
derivation           INTERDIT — une origine HUMAN n'a pas de dérivation
score, weight, rank  INTERDITS — aucun champ de mérite n'existe (§26)
content              TOUJOURS présent, toujours humain
```

**Le contenu humain est obligatoire.** Aucun acte humain autoritaire ne
peut exister dont la seule substance serait le contenu d'une proposition CCR.

## 9.3 Ce qu'un acte humain établit

```text
ÉTABLIT       qu'une personne a enregistré ce contenu, sur ce périmètre, à cette
              date, avec ces effets déclarés
N'ÉTABLIT PAS que le contenu soit vrai
N'ÉTABLIT PAS que les experts soient d'accord
N'ÉTABLIT PAS qu'une convergence existe
```

---

# 10. Forme d'autorité humaine V5

## 10.1 Ce que le runtime ne possède pas

Le runtime CCR actuel ne possède :

```text
ni identité humaine durable
ni rôle d'habilitation hiérarchique
ni gradation vérifiable entre plusieurs autorités humaines
```

Le domaine V3 l'énonce : pour une origine `HUMAN`, le champ d'acteur est
**interdit**, aucune identité humaine durable n'existant dans CCR.

la doctrine pose cependant l'autorité humaine comme **finale, sans gradation interne
supplémentaire**. Il n'existe donc pas de second palier auquel un acte pourrait ne
pas atteindre.

## 10.2 Définition retenue

Pour le présent contrat, `V5_HUMAN_AUTHORITY_FORM` désigne la satisfaction de la
forme d'autorité humaine que CCR peut **effectivement établir** :

```text
H1  origine sémantique HUMAN
H2  acte produit par le chemin de mutation humaine (§40)
H3  effet déclaré EXPLICITEMENT et SÉPARÉMENT — jamais dérivé de l'existence
    de l'opération
H4  périmètre de l'effet déclaré EXPLICITEMENT et énuméré (§6)
H5  acte validé contre un instantané autoritaire frais (§32)
```

Cinq conditions cumulatives. **`provenance` n'en fait pas partie.**

## 10.3 Ce que cette forme établit, et ce qu'elle n'établit pas

```text
ÉTABLIT       « cet effet a été enregistré comme acte humain explicite
              satisfaisant le contrat V5, sur ce périmètre, contre cet état »

N'ÉTABLIT PAS IDENTITY_VERIFIED
N'ÉTABLIT PAS ROLE_VERIFIED
N'ÉTABLIT PAS LEGAL_AUTHORIZATION_VERIFIED
N'ÉTABLIT PAS PERSON_ENTITLEMENT_VERIFIED
N'ÉTABLIT PAS que la personne avait raison
```

**Cette limitation est rendue visible dans l'autorité de sortie** (§24.4) : la
lecture dit « effet déclaré par un acte humain explicite », jamais « effet décidé
par une autorité authentifiée comme habilitée ».

## 10.4 `provenance`

```text
provenance =  { kind: 'DECLARED', statement: <texte borné> }
           |  { kind: 'CONTROVERSY_AUTHORITY', entry_id: ctve_… }
           |  { kind: 'LEGACY_DECISION', decision_id: dec_… }
```

Champ **obligatoire d'auditabilité**. Il ne contribue à `H1`–`H5` d'aucune manière.

```text
PROVENANCE_PRESENT  ≠  AUTHORITY_VERIFIED
REFERENCE_EXISTS    ≠  AUTHORITY_SUFFICIENT
PROVENANCE          ≠  AUTHORITY
AUDITABILITY        ≠  AUTHORIZATION
```

`LEGACY_DECISION` demeure `REFERENCE_ONLY` (§28) et ne confère jamais d'autorité.

## 10.5 Interdits explicites

```text
INTERDIT   « commande CLI exécutée » ⇒ autorité
INTERDIT   déduire l'autorité du fournisseur
INTERDIT   déduire l'autorité du rôle d'expert
INTERDIT   déduire l'autorité de `recorded_by`
INTERDIT   déduire l'autorité de l'ordre temporel ou de la récence
INTERDIT   qu'un effet naisse comme conséquence d'une opération non déclarée
```

`H3` est le cœur : **une opération ordinaire ne produit jamais un effet**.

## 10.6 Aucun palier d'habilitation supérieur

Une supersession exige un **acte humain explicite**, soumis aux préconditions
générales d'un acte humain V5 valide (§10.2). Il n'existe aucun niveau
d'habilitation au-dessus de cette forme : superséder n'est pas un pouvoir
particulier, c'est un effet déclaré comme les autres.

---

# 11. `C` — proposition CCR

```text
RECONCILIATION_PROPOSED
  schema_version, entry_id, kind
  target                { kind: 'CONTROVERSY', controversy_id: ctv_… }
  scope_kind, scope     énumération non vide
  semantic_origin       'CCR'
  derivation            { method, invocation_id?, inputs }   obligatoire
  recorded_by           'CCR'
  recorded_at           horodatage
  options               [ option, … ]        non vide, non classées (§12)
  observed_revision     révision autoritaire
```

```text
CCR_PROPOSAL_HAS_NO_EFFECT_BY_ITSELF = TRUE

closure             INTERDIT      supersedes   INTERDIT
closure_withdrawal  INTERDIT      provenance   INTERDIT
score / rank        INTERDITS     currentness  aucune
```

```text
ÉTABLIT       que CCR a produit et enregistré cette proposition, dans ce
              contexte, à partir de ces entrées
N'ÉTABLIT PAS qu'elle soit correcte, ni qu'elle doive être suivie
N'ÉTABLIT PAS qu'une option soit meilleure qu'une autre
```

---

# 12. Options, sans classement

```text
options  =  [ { option_id, content }, … ]      un ou plusieurs éléments
```

Interdits, absents du schéma :

```text
score            weight           confidence-on-merits
best             recommended      preferred            rank
first-is-best    ordre signifiant
```

```text
ORDER ≠ PREFERENCE       SINGLE ≠ WINNER
```

Une proposition à une seule option reste **non contraignante**. Toute surface rend
les options dans l'ordre serveur, sans tri, sans mise en avant, sans marqueur de
préférence, et sans nommer une option « principale ».

---

# 13. Réponse humaine à une proposition

## 13.1 Deux objets, deux portées

```text
PROPOSAL_RESPONSE_RECORDED    enregistre une réponse humaine — AUCUN effet
RECONCILIATION_RECORDED       seul objet pouvant porter un effet autoritaire
```

```text
PROPOSAL_RESPONSE_RECORDED
  entry_id, kind
  target            { kind: 'CONTROVERSY', controversy_id: ctv_… }
  semantic_origin   'HUMAN'
  responds_to       { proposal_id: rcn_…, mode: ACCEPT | REJECT,
                      responded_option_id?: … }
  provenance        (§10.4)
  observed_revision révision autoritaire

  scope_kind          ABSENT — l'enregistrement ne gouverne aucune unité
  scope               ABSENT — idem
  content             ABSENT — la réponse n'est pas un contenu de décision
  closure             INTERDIT
  closure_withdrawal  INTERDIT
  supersedes          INTERDIT
```

**`E1` — pourquoi aucun périmètre.** Cet enregistrement ne porte aucun effet. Un
périmètre n'y gouvernerait rien, et sa seule présence inviterait à le lire comme
le périmètre d'un effet. La forme canonique le retire plutôt que de lui inventer
une sémantique.

```text
ACCEPT RESPONSE  ≠  AUTHORITATIVE RECONCILIATION ACT
```

Une réponse `ACCEPT` ou `REJECT`, seule, ne produit **ni clôture, ni retrait de
clôture, ni supersession, ni autorité `E`**.

## 13.2 Produire un effet à la suite d'une proposition

L'humain enregistre un `RECONCILIATION_RECORDED` complet, portant :

```text
content            son propre contenu attribué                OBLIGATOIRE
target, scope      les siens, déclarés                        OBLIGATOIRE
provenance         (§10.4)                                    OBLIGATOIRE
responds_to        { proposal_id, relation, adopted_option_id? }
effets             closure / closure_withdrawal / supersedes, explicites
```

## 13.3 Les trois relations à une proposition

```text
ADOPTS      le contenu humain reprend le contenu proposé ; l'humain le fait sien
            par déclaration explicite, et `adopted_option_id` le désigne
            sans ambiguïté
MODIFIES    la proposition CCR demeure la base explicite d'un contenu humain
            modifié
REPLACES    le contenu humain résultant est indépendant du contenu proposé ;
            la proposition demeure contexte et référence seulement
```

Trois valeurs, trois sémantiques distinctes. Aucun faux enum : `ADOPTS` réfère
l'option adoptée, `MODIFIES` conserve la proposition comme base, `REPLACES` ne la
conserve que comme contexte.

Dans les trois cas, `content` est présent et humain.

## 13.4 Attribution

```text
HUMAN ACCEPTANCE  ≠  HUMAN AUTHORSHIP OF CCR REASONING
HUMAN ACCEPTANCE  ≠  RETROACTIVE VALIDATION OF CCR REASONING
```

La lecture distingue toujours quatre choses : le contenu proposé par CCR, la
dérivation CCR, le contenu de décision humain, les effets humains. Le raisonnement
CCR n'est jamais attribué à l'humain, même sous `ADOPTS`.

## 13.5 `E2` / `E3` — les deux références d'option

Deux champs distincts, deux sémantiques distinctes. Ils ne sont **pas** synonymes
et ne sont donc pas normalisés en un seul nom.

```text
RESPONSE OPTION REFERENCE          responds_to.responded_option_id
    portée par PROPOSAL_RESPONSE_RECORDED
    désigne l'option SUR LAQUELLE porte la réponse humaine
    AUCUN effet — ni adoption, ni autorité, ni contenu de décision

ADOPTED OPTION REFERENCE           responds_to.adopted_option_id
    portée par RECONCILIATION_RECORDED sous la relation ADOPTS
    désigne l'option dont le contenu est fait sien par l'humain
    accompagne TOUJOURS un `content` humain (§13.3)
```

```text
RESPONSE OPTION REFERENCE  ≠  ADOPTED OPTION REFERENCE
RESPONSE OPTION REFERENCE  ≠  ADOPTION HUMAINE AUTORITAIRE
```

**`E3` — validation de la référence de réponse.** Lorsque `responded_option_id`
est présent :

```text
1  la proposition référencée existe
2  l'option existe DANS CETTE proposition — aucune référence croisée n'est
   admise vers l'option d'une autre proposition
3  la référence est validée déterministement avant écriture
4  la référence ne produit AUCUN effet autoritaire
```

Aucun identifiant canonique référençable ne subsiste sans contrôle d'existence et
de cohérence.

## 13.6 Interdits de surface

```text
INTERDIT   accept-only : une surface n'offrant que ACCEPT
INTERDIT   acceptation par défaut
INTERDIT   acceptation par expiration de délai
INTERDIT   acceptation par silence
```

```text
REAL_HUMAN_OVERRIDE = REQUIRED
```

Les quatre opérations `ACCEPT` · `REJECT` · `MODIFY` · `REPLACE` restent réellement
disponibles, et la surface `B` existe **indépendamment de toute proposition** (§40).

---

# 14. `D` — détection structurelle

## 14.1 Principe

```text
OBSERVED STRUCTURAL FACT   ce que l'instantané contient réellement
INTERPRETATION             hors contrat
```

## 14.2 Catégories — ensemble fermé

| # | Catégorie | Prédicat déterministe | N'établit pas |
|---|---|---|---|
| `D01` | entrée hors de tout périmètre V5 | l'unité n'appartient au périmètre d'aucun acte V5 | qu'il faille la traiter |
| `D02` | entrée sans effet de clôture courant | `CLOSURE_EFFECT_CURRENTNESS(e)` est vide (§20.3) | qu'un désaccord subsiste |
| `D03` | acte humain non courant comme décision sur une partie de son périmètre | une relation de supersession explicite le vise sur cette unité (§19.1) | que l'acte soit faux, ni que sa clôture ait cessé |
| `D04` | actes courants multiples sur une même unité | `card(current_decisions(e)) ≥ 2` (§19.4) | qu'il faille les départager |
| `D05` | proposition sans réponse humaine enregistrée | aucune réponse ni acte ne la référence | qu'une réponse soit due |
| `D06` | acte dont la provenance est une décision legacy | `provenance.kind = LEGACY_DECISION` | que la provenance soit invalide |
| `D07` | ancrage de citation non résolvable dans le périmètre | motif de non-résolution existant en lecture V3 | que la citation soit fausse |
| `D08` | effet de clôture retiré sur une unité | un retrait explicite courant vise cet effet sur cette unité | qu'une réouverture soit un échec |

**Dépendances des détections.** `D02` dépend de
l'actualité **d'effet de clôture**, `D03` et `D04` de l'actualité **de décision**.
Aucune détection n'importe la règle `R1` rejetée : `D03` énonce explicitement qu'un
acte non courant comme décision **n'a pas pour autant perdu sa clôture**.

## 14.3 Interdits

```text
INTERDIT   plus d'adductions            ⇒ plus fort
INTERDIT   pas de clôture               ⇒ désaccord maintenu
INTERDIT   plus récent                  ⇒ superseding
INTERDIT   contradiction textuelle      ⇒ supersession
INTERDIT   supersession                 ⇒ retrait de clôture
INTERDIT   orientation                  ⇒ vérité
INTERDIT   absence de disposition       ⇒ erreur
INTERDIT   toute catégorie qui qualifierait un contenu
```

```text
DETECTION ≠ REMEDIATION
```

---

# 15. Terminologie « résidu »

```text
RESIDUAL_AS_CANONICAL_CONCEPT = NO
```

Les huit catégories sont nommées par ce qu'elles observent, jamais par ce qu'elles
suggéreraient.

---

# 16. `G` — effet de clôture

## 16.1 Nature

`G` n'est pas un acte. C'est un champ d'effet porté par un acte humain.

```text
closure  =  { declared: true, statement: <texte borné> }
```

Absent ⇒ aucun effet de clôture. Aucune valeur implicite.

## 16.2 Préconditions cumulatives

```text
1  kind = RECONCILIATION_RECORDED
2  V5_HUMAN_AUTHORITY_FORM satisfaite (§10.2, H1–H5)
3  target = ctv_ explicite
4  scope explicite et énuméré, non vide
5  closure.declared = true, explicitement porté par l'acte
6  observed_revision valide et fraîche (§32)
7  toutes les ctve_ du périmètre valides (§6.4)
```

## 16.3 Portée de l'effet

L'effet porte **exactement** sur les unités énumérées du périmètre de l'acte.

```text
CLOSURE_OUTSIDE_SCOPE = NO
```

## 16.4 Ce qui ne produit jamais de clôture

```text
proposition CCR · détection · sortie modèle · absence de signal de désaccord
silence · retrait d'une position · inactivité · couverture structurelle complète
réponse ACCEPT seule · supersession d'un autre acte
```

## 16.5 Ce qu'une clôture n'établit pas

```text
CLOSURE  ≠  TRUTH
CLOSURE  ≠  CONVERGED
CLOSURE  ≠  EXPERT AGREEMENT
CLOSURE  ≠  effacement du désaccord historique
```

---

# 17. Clôture partielle et clôture totale

## 17.1 Deux faits distincts

```text
PARTIAL CLOSURE            un acte à périmètre SUBSET porte une clôture
WHOLE-SCOPE CLOSURE        un acte à périmètre WHOLE porte une clôture
```

```text
PARTIAL_RECONCILIATION  ≠  FULL_CONTROVERSY_CLOSURE
```

## 17.2 Terminologie

Deux faits dérivés, nommés pour ce qu'ils sont :

```text
A  historical_explicit_whole_scope_closure_declaration
   un humain a déclaré une clôture sur le périmètre WHOLE — borné à l'instantané
   de cet acte — et cette déclaration est enregistrée

B  current_all_entries_closure_coverage
   toutes les ctve_ actuellement observées de la controverse sont couvertes par
   un effet de clôture courant
```

```text
A  ≠  B
```

Une `ctve_` apparue depuis peut rendre `B` faux **sans** rendre `A`
historiquement faux. Aucun nom ne transforme `A` en `B`, et aucune lecture ne
présente `A` comme « cette controverse entière est actuellement close ».

```text
STRUCTURAL COVERAGE  ≠  HUMAN WHOLE-CLOSURE DECISION
```

Aucune règle ne convertit `B` en une clôture déclarée.

---

# 18. Supersession de décision

## 18.1 Forme

```text
supersedes  =  [ { superseded_act_id: rcn_…,
                   supersession_scope: [ ctve_… ] }, … ]
```

**Chaque relation porte son propre périmètre explicite.** Le contrat ne calcule
aucune intention humaine.

## 18.2 Préconditions cumulatives

```text
1  l'acte superseding est un RECONCILIATION_RECORDED valide (§10.2)
2  l'acte superseded existe et est un acte humain V5
3  même controverse cible
4  supersession_scope explicitement énuméré et NON VIDE
5  supersession_scope ⊆ scope(acte superseding)
6  supersession_scope ⊆ scope(acte superseded)
7  pas d'auto-référence
8  aucun doublon de superseded_act_id dans un même acte
9  acyclicité PAR UNITÉ de périmètre (§18.5)
```

```text
VALIDATION  ≠  SCOPE AUTHORSHIP
```

Les conditions 5 et 6 **valident** que le périmètre déclaré appartient à
l'intersection ; elles ne le **produisent** pas. Une intersection vide rend toute
relation valide impossible, et l'acte est refusé.

## 18.3 Classes superséssibles — ensemble fermé

```text
SUPERSÉDABLE      RECONCILIATION_RECORDED · PROPOSAL_RESPONSE_RECORDED
NON SUPERSÉDABLE  RECONCILIATION_PROPOSED · détection · vue dérivée
                  · relation V3 · acte probatoire V4
```

## 18.4 Exemple normatif

```text
H1  scope = { ctve_1, ctve_2, ctve_3 }
H2  scope = { ctve_2, ctve_4 }

Pour superséder H1 sur ctve_2, H2 déclare :
    supersedes = [ { superseded_act_id: H1, supersession_scope: [ ctve_2 ] } ]

Validation : { ctve_2 } ⊆ scope(H2) ✓   et   { ctve_2 } ⊆ scope(H1) ✓
Résultat   : la relation ne porte QUE sur ctve_2 ; ctve_4 n'est jamais touchée
```

Si un acte supersède plusieurs actes antérieurs, **chaque relation porte son
propre périmètre**. Aucun périmètre calculé n'est réutilisé.

## 18.5 Cycles par unité

L'acyclicité est vérifiée **par unité `ctve_`** :

```text
pour chaque ctve_ e :
    construire le graphe orienté des relations de supersession dont le
    supersession_scope contient e
    exiger l'absence de cycle dans ce graphe
```

```text
INTERDIT   H1 → H2 → H1 sur la même ctve_
INTERDIT   H1 → H2 → H3 → H1 sur la même ctve_
AUTORISÉ   des relations réciproques sur des unités DISJOINTES — aucun cycle
           n'existe alors sur une unité commune, et la sémantique reste
           déterminée
SELF_SUPERSESSION  toujours interdit, globalement
```

## 18.6 Ce qui ne produit jamais une supersession

```text
RECENCY        ≠  SUPERSESSION
CONTRADICTION  ≠  SUPERSESSION
NEW_DECISION   ≠  AUTOMATIC_SUPERSESSION
```

## 18.7 Ce qu'une supersession n'établit pas

```text
SUPERSEDED  ≠  FALSE          SUPERSEDED  ≠  DELETED
SUPERSEDED  ≠  NEVER HAPPENED SUPERSEDED  ≠  TRUTH CORRECTION
SUPERSEDED  ≠  RETRAIT DE CLÔTURE
```

```text
MUTATE_OLD_DECISION      = NO
MUTABLE_CURRENT_POINTER  = NO
```

Aucun cycle de vie canonique. `ACTIVE`, `SUPERSEDED`, `REVOKED`, `TEMPORARY` ne
sont pas des valeurs de ce contrat.

---

# 19. Actualité de décision

## 19.1 Algorithme

```text
Pour tout acte humain H et toute unité e ∈ scope(H) :

  current_decision(H, e)  ⟺  ¬∃ relation R enregistrée telle que
                                R.superseded_act_id = H
                             ∧  e ∈ R.supersession_scope
```

Déterministe, sans horloge, sans ordre, sans arbitrage.

## 19.2 Bornes

```text
RECENCY   ≠  CURRENTNESS        LATEST  ≠  CURRENT
```

L'actualité ne dépend **que** des relations explicites. Un acte plus récent qui ne
supersède rien ne rend rien non courant.

## 19.3 Transitivité et absence de résurrection

```text
La relation de supersession est un FAIT HISTORIQUE EXPLICITE.
Elle n'est PAS implicitement transitive.
```

`H3` supersédant `H2`, et `H2` supersédant `H1`, ne crée **pas** la relation
enregistrée « `H3` supersède `H1` ».

L'algorithme du §19.1 teste **l'existence de la relation**, jamais l'actualité de
son auteur. Donc :

```text
H2 supersède H1 sur e     →  H1 non courant sur e
H3 supersède H2 sur e     →  H2 non courant sur e ; H3 peut être courant
Résultat                  →  H1 DEMEURE non courant sur e
```

```text
AUCUNE RÉSURRECTION IMPLICITE
```

Pour qu'une décision antérieure redevienne applicable, **un nouvel acte humain
doit exprimer la nouvelle décision**. On ne réactive jamais rétroactivement un
acte. La récence ne participe à aucune étape de cet algorithme.

## 19.4 Actes courants multiples

Deux actes humains portant sur la même unité, sans relation de supersession, sont
**tous deux courants**.

```text
INTERDIT  en choisir un automatiquement
INTERDIT  départager par date, par identité, par ordre d'append
```

`current_decisions(e)` est exposé comme un **ensemble**. `D04` le signale sans le
résoudre.

## 19.5 Aucun pointeur mutable

```text
DERIVED_CURRENTNESS      = YES
MUTABLE_CURRENT_POINTER  = NO
```

---

# 20. Actualité d'effet de clôture

## 20.1 Indépendance des deux actualités

```text
DECISION_CURRENTNESS  ≠  CLOSURE_EFFECT_CURRENTNESS
```

**La supersession n'est pas une entrée du calcul d'actualité d'un effet de
clôture.** Les deux dérivations n'ont aucune entrée commune :

```text
DECISION_CURRENTNESS         ← relations de supersession, seules
CLOSURE_EFFECT_CURRENTNESS   ← déclarations de clôture et de retrait, seules
```

## 20.2 Identification d'un effet de clôture

Un effet de clôture est identifié par le couple :

```text
( act_id de l'acte déclarant la clôture , unité ctve_ de son périmètre )
```

## 20.3 Algorithme

```text
Un effet ( H , e ) est courant  ⟺  H.closure.declared = true
                                ∧  e ∈ scope(H)
                                ∧  ¬∃ retrait W enregistré tel que
                                      H ∈ W.withdrawn_closures
                                   ∧  e ∈ W.withdrawal_scope

CLOSURE_EFFECT_CURRENTNESS(e) = { H : ( H , e ) est courant }
```

Si l'ensemble est vide :

```text
CLOSURE_EFFECT_CURRENTNESS(e) = NONE
```

## 20.4 Ce qui ne retire jamais un effet de clôture

```text
SUPERSESSION_ALONE_CAUSES_REOPENING   = NO
RECENCY_CAUSES_REOPENING              = NO
CONTRADICTION_CAUSES_REOPENING        = NO
NEW_DECISION_CAUSES_REOPENING         = NO
CCR_PROPOSAL_CAUSES_REOPENING         = NO
CCR_DETECTION_CAUSES_REOPENING        = NO
MODEL_OUTPUT_CAUSES_REOPENING         = NO
SILENCE_CAUSES_REOPENING              = NO
```

```text
AUCUNE RÉOUVERTURE IMPLICITE
```

---

# 21. Retrait de clôture

## 21.1 Nature

Champ d'effet porté par un acte humain, **distinct** de la clôture et **distinct**
de la supersession.

```text
closure_withdrawal  =  { declared: true,
                         withdrawn_closures: [ rcn_…, … ],
                         withdrawal_scope:   [ ctve_… ],
                         statement:          <texte borné> }
```

## 21.2 Préconditions cumulatives

```text
1  kind = RECONCILIATION_RECORDED
2  V5_HUMAN_AUTHORITY_FORM satisfaite (§10.2)
3  target = ctv_ explicite, identique à celui des clôtures visées
4  withdrawal_scope explicitement énuméré, non vide
5  withdrawal_scope ⊆ scope(acte de retrait)
6  withdrawn_closures non vide, sans doublon
7  chaque acte visé existe, est humain, et déclare effectivement une clôture
8  withdrawal_scope ⊆ scope de chaque clôture visée
9  observed_revision valide et fraîche
```

## 21.3 Désignation non ambiguë

Lorsque plusieurs effets de clôture existent sur une même unité, le retrait
**énumère explicitement** les actes dont il retire la clôture.

```text
INTERDIT   latest closure wins
INTERDIT   retrait par défaut de toutes les clôtures d'une unité
INTERDIT   retrait implicite par supersession
```

## 21.4 Historicité

```text
HISTORICAL CLOSURE DECLARATION      demeure enregistrée et lisible
HISTORICAL WITHDRAWAL DECLARATION   demeure enregistrée et lisible
CURRENT CLOSURE EFFECT              se dérive des deux
```

```text
REOPENING  ≠  TRUTH CORRECTION
REOPENING  ≠  PERSISTENT DISAGREEMENT
REOPENING  ≠  NEGATIVE CONVERGENCE
REOPENING  ≠  ERASURE OF HISTORICAL CLOSURE
```

Le contrat n'emploie jamais « l'histoire a été rouverte » ni « la clôture a été
effacée ».

## 21.5 Matrice de cas

| Cas | Situation | Actualité de décision | Effet de clôture |
|---|---|---|---|
| `A` | `H2` supersède `H1`, rien sur la clôture | `H1` non courant sur le périmètre de la relation | **inchangé** |
| `B` | `H2` supersède `H1` et déclare une clôture | selon la relation | nouvel effet ajouté sur le périmètre de `H2` |
| `C` | `H2` supersède `H1` et retire sa clôture sur `S` | selon la relation | effet de `H1` retiré **uniquement sur `S`** |
| `D` | `H2` ne supersède pas, retire la clôture de `H1` sur `S` | **inchangée** | effet de `H1` retiré uniquement sur `S` |
| `E` | `H2` supersède sur `S1`, retire la clôture sur `S2` | selon `S1` | retrait selon `S2` |

Aucun effet hors du périmètre déclaré, dans aucun des cinq cas.

## 21.6 Aucun cycle de vie global

```text
INTERDIT   OPEN · CLOSED · REOPENED  comme cycle de vie canonique
```

```text
DERIVED CURRENT CLOSURE  ≠  GLOBAL CONTROVERSY LIFECYCLE
HISTORICAL EFFECT TYPE   ≠  GLOBAL LIFECYCLE STATE
```

---

# 22. Vue dérivée du désaccord

```text
DERIVED_DISAGREEMENT_VIEW              = YES
POSITIVE_CANONICAL_DISAGREEMENT_STATE  = NO
```

## 22.1 Signaux admis — liste fermée

```text
S1  RELATION_RECORDED avec act = CONTESTS
S2  RELATION_RECORDED avec act = WITHDRAWS      — fait attribué, pas une clôture
S3  HUMAN_AUTHORITY_RECORDED avec act = CONTEST_RELATION
S4  NATURE_RECORDED
```

Chaque signal est rendu avec son identité, son attribution et son ancrage.

## 22.2 Interdits

```text
INTERDIT  NO_CLOSURE            ⇒  PERSISTENT_DISAGREEMENT
INTERDIT  retrait de clôture    ⇒  PERSISTENT_DISAGREEMENT
INTERDIT  absence de signal     ⇒  accord
INTERDIT  compte de signaux     ⇒  intensité
INTERDIT  score de désaccord    ·  état positif canonique
```

```text
DISAGREEMENT_VIEW  ≠  FAILURE
DISAGREEMENT_VIEW  ≠  NEGATIVE_CONVERGENCE
DISAGREEMENT_VIEW  ≠  CLOSURE
```

---

# 23. `CONVERGED`

```text
CONVERGED = RESERVED
```

Le contrat ne le définit pas, ne l'emploie pas comme état, ne le déduit d'aucune
clôture ni d'aucun retrait, et n'en déduit rien.

```text
CLOSED               ≠  CONVERGED
CLOSURE WITHDRAWAL   ≠  NEGATIVE CONVERGENCE
```

Une controverse close peut conserver un désaccord expert entier.

---

# 24. Autorité de sortie

## 24.1 Niveaux

```text
A  existence de l'acte                              autoritaire
B  provenance et attribution                        autoritaire
C  contenu attribué                                 autoritaire
D  décision humaine enregistrée                     autoritaire
E  effet exact déclaré sur un périmètre explicite   autoritaire sous conditions
F  vérité du fond                                   NON AUTORISÉ
```

## 24.2 `E` — quatre effets distincts

```text
E1  effet de réconciliation déclaré par un humain
E2  effet de clôture déclaré par un humain
E3  effet de retrait de clôture déclaré par un humain
E4  effet de supersession déclaré par un humain
```

Tous les quatre : **`HUMAN` seulement · périmètre explicite · effet explicite**.
Aucune de ces sémantiques n'est jamais implicite.

```text
CCR_PROPOSAL_ALONE     →  aucun E
CCR_DETECTION_ALONE    →  aucun E
MODEL_OUTPUT_ALONE     →  aucun E
ACCEPT_RESPONSE_ALONE  →  aucun E
LEGACY_DECISION_ALONE  →  aucun E
V3_AUTHORITY_ALONE     →  aucun E
```

## 24.3 Séparation obligatoire dans la lecture

```text
RECORDED FACT               un acte existe, avec sa provenance
DERIVED FACT                actualité de décision, couverture, signaux
HUMAN-AUTHORITATIVE EFFECT  clôture courante, retrait courant, supersession
CCR PROPOSAL                proposition, sans effet
STRUCTURAL DETECTION        prédicat observé
```

```text
INTERDIT   decision non-current  →  closure automatiquement absente
INTERDIT   historical whole closure  →  controverse actuellement close
```

## 24.4 Limitation rendue visible

Toute lecture qui expose un effet autoritaire l'énonce comme :

```text
« effet déclaré par un acte humain explicite satisfaisant le contrat V5 »
```

et jamais comme :

```text
« effet décidé par une personne authentifiée et habilitée »
```

---

# 25. Vérité du fond

```text
F = NOT AUTHORIZED
```

Aucun champ, aucune issue, aucune valeur ne signifie, dans un sens de mérite :

```text
TRUE · FALSE · CORRECT · INCORRECT · WINNER · LOSER · BEST · STRONGER · WEAKER
```

Les booléens techniques — `closure.declared`, `closure_withdrawal.declared`,
`current_decision(H,e)`, `present` — portent une sémantique **structurelle**,
jamais argumentative.

---

# 26. Pondération et classement

## 26.1 Interdits

```text
evidence weight        reliability score      credibility score
support count score    orientation balance    merits confidence
probability of truth   preferred evidence     preferred claim
winner                 ranked recommendation
```

Aucun de ces champs n'existe dans le schéma.

## 26.2 Ordres exposés

| Ordre | Signification | Ne signifie pas |
|---|---|---|
| append du journal V5 | ordre d'écriture | ni priorité, ni actualité, ni mérite |
| `options` | ordre de sérialisation | aucune préférence |
| périmètre énuméré | ordre de déclaration | aucune importance relative |
| `supersedes` | ordre de déclaration | aucune préséance entre relations |
| `withdrawn_closures` | ordre de déclaration | aucune préséance entre clôtures |
| identités `rcn_` | séquence par run | aucune préséance |
| ordre serveur du read model | autoritaire | aucune affirmation métier |

```text
ORDER ≠ PREFERENCE
```

## 26.3 Interdit de reconstruction indirecte

Aucune surface ne trie, ne regroupe, ne déduplique ni ne met en avant un élément
d'une séquence canonique.

---

# 27. Persistance

## 27.1 Journal dédié

Un journal propre au moteur, distinct des journaux V3 et V4. Aucun objet V3 ou V4
n'est muté, et aucun champ n'y est ajouté.

## 27.2 Propriétés exigées

```text
CLASSES D'ENREGISTREMENT   RECONCILIATION_PROPOSED
                           RECONCILIATION_RECORDED
                           PROPOSAL_RESPONSE_RECORDED
VERSION DE SCHÉMA          propre au journal V5
ORDRE                      append, séquences strictement croissantes
CORRUPTION                 une ligne invalide fait lever la lecture
IDENTITÉ DUPLIQUÉE         refusée à la lecture
RÉVISION                   fondée sur le contenu observé
ABSENT vs PRÉSENT-VIDE     distingués dans la révision
```

## 27.3 Espace de révision

Le journal de réconciliation porte son propre jeton de fraîcheur, dans un espace
de noms qui lui est propre :

```text
reconciliation_revision      rcn-sha256:<64 hex>
```

Quatre espaces de noms coexistent, et ne se comparent **jamais** :

```text
sha256:      état opérationnel du run
ctv-sha256:  journal des controverses
ev-sha256:   journal des matériaux
rcn-sha256:  journal de réconciliation
```

Le domaine entre dans l'empreinte elle-même : un jeton de ce journal ne peut être
confondu avec un autre, ni par un lecteur humain, ni par une comparaison de
chaînes. Une égalité d'empreintes entre deux domaines n'aurait **aucune
signification**, et aucune lecture n'en établit une.

```text
COMPARAISON DE RÉVISION INTER-DOMAINES  =  INTERDITE
RÉVISION  ≠  MÉRITE      RÉVISION  ≠  ACTUALITÉ
```

Le jeton mesure le **contenu observé** de la source de ce domaine, dans la même
fenêtre stable que le reste du snapshot. Il n'encode ni actualité, ni clôture, ni
priorité, ni convergence.

Deux règles closent l'espace :

```text
ABSENT  ≠  PRÉSENT-VIDE
```

L'absence de journal est l'état normal d'un run qui n'a rien enregistré ; elle
n'est ni une erreur, ni un journal vide, et les deux se distinguent dans la
lecture.

La révision est **server-authoritative**. Aucune n'est reconstruite côté client,
et une queue non terminée ne la fait pas varier : ce qui n'a pas encore été
écrit n'est pas encore observé.

## 27.4 Non-généralisation

```text
Les actes V5 historiques ne sont pas réécrits.
Cela ne pose PAS que tout état CCR serait append-only.
```

Les retraits de clôture sont des **enregistrements historiques nouveaux**, jamais
des modifications rétroactives.

---

# 28. `decisions.jsonl` — décisions legacy

```text
LEGACY_DECISIONS_ROLE = REFERENCE_ONLY
```

Le journal legacy porte un identifiant, un round, un horodatage, une catégorie
d'auteur, un statut à valeur unique et un contenu libre. Il n'a **ni cible, ni
périmètre**, et n'est pas observé dans l'instantané stable.

```text
AUTORISÉ    référencer via provenance.kind = LEGACY_DECISION
INTERDIT    la consommer comme autorité humaine V5 scopée
INTERDIT    lui inférer un périmètre ou une cible
INTERDIT    la convertir automatiquement en acte V5
```

L'absence de périmètre reste **significative**. `provenance` ne contribuant pas à
`H1`–`H5` (§10.4), une référence legacy ne peut satisfaire indirectement aucune
condition d'autorité.

---

# 29. Interopérabilité avec l'autorité humaine V3

`HUMAN_AUTHORITY_RECORDED` porte un acte parmi `ARBITRATION`, `CONFIRM_RELATION`,
`CONTEST_RELATION`, une origine `HUMAN`, une cible d'entrée optionnelle et un
`scope` **en texte libre**. Ce `scope` ne satisfait pas `CANONICAL_SCOPE_UNIT`, et
sa cible est une entrée, non une controverse.

```text
V3 HUMAN AUTHORITY   peut être RÉFÉRENCÉE via provenance.kind =
                     CONTROVERSY_AUTHORITY
V5 ACT               est un enregistrement nouveau et distinct
```

```text
INTERDIT   dupliquer une autorité V3 en acte V5
INTERDIT   fusionner les deux sémantiques
INTERDIT   dériver un périmètre V5 du `scope` textuel V3
```

---

# 30. Instantané stable

```text
V5_SNAPSHOT_SOURCE = YES        cinq sources → six
```

L'actualité de décision, l'actualité d'effet de clôture et la vue du désaccord se
calculent **conjointement** sur l'état du run, le journal V3 et le journal V5. Sans
observation commune, une lecture pourrait rendre des ensembles qui n'ont jamais
coexisté.

```text
observation par signature physique, sans verrou
absence rendue comme signature stable
retry borné, puis refus explicite d'instabilité
révision V5 additive
ordre serveur autoritaire
```

---

# 31. Read model

## 31.1 Forme

Projection **additive et versionnée**, composée depuis le **même** instantané que
la lecture autoritaire à laquelle elle correspond, sans réécrire aucune valeur.

## 31.2 Disponibilité

```text
NOT_AVAILABLE   run non concerné — la forme ne porte AUCUN compteur
AVAILABLE       run natif ; recorded_count possiblement 0
```

## 31.3 Contenu exposé — distinctions obligatoires

```text
actes humains historiques
propositions, avec options non classées
réponses humaines, avec leur mode
périmètres énumérés, avec scope_kind
déclarations de clôture historiques
déclarations de retrait de clôture historiques
relations de supersession, avec leur périmètre propre
DECISION_CURRENTNESS                                 par acte et par unité
CLOSURE_EFFECT_CURRENTNESS                           par unité, ensemble
current_decisions(e)                                 ensemble, jamais une valeur
historical_explicit_whole_scope_closure_declaration  booléen  (§17.2 A)
current_all_entries_closure_coverage                 booléen  (§17.2 B)
DERIVED_DISAGREEMENT_VIEW                            signaux S1–S4
STRUCTURAL_DETECTIONS                                D01–D08
provenance et attribution
révision V5
```

## 31.4 Interdits

```text
INTERDIT  reconstruire une autorité absente
INTERDIT  remplacer un inconnu par un zéro
INTERDIT  agréger les deux actualités en un statut
INTERDIT  déduire l'absence de clôture d'une décision non courante
INTERDIT  réordonner une séquence canonique
```

```text
UNKNOWN  ≠  ZERO          ABSENT  ≠  PRESENT-EMPTY
```

---

# 32. Fraîcheur

Toute mutation déclare la révision autoritaire sur laquelle elle a été préparée, et
cette révision est revérifiée **sous le verrou**, immédiatement avant l'écriture.

```text
expected_revision   fourni par l'appelant
observed_revision   revérifié sous verrou et enregistré sur l'acte
```

Un périmètre `WHOLE` est **énuméré sous le verrou**, contre l'état revérifié. Une
énumération préparée contre un état périmé est refusée, jamais complétée.

---

# 33. Concurrence

```text
un seul écrivain par run — verrou local, verrou périmé traité explicitement
allocation d'identité, validation de périmètre, de supersession, de clôture et
de retrait : toutes sous verrou, contre l'état revérifié
append atomique
le verrou n'est jamais tenu pendant un appel fournisseur
```

| Situation | Issue |
|---|---|
| révision attendue périmée | `REFUSED` |
| instantané instable après retry borné | `REFUSED` |
| verrou détenu ailleurs | `REFUSED`, réessayable avant engagement |
| journal corrompu | `REFUSED` |
| échec après engagement fournisseur, sans retour | `UNKNOWN_AFTER_COMMITMENT` |

```text
UNKNOWN_AFTER_COMMITMENT  ≠  PROVIDER_FAILED
```

`UNKNOWN_AFTER_COMMITMENT` n'apparaît que lorsqu'une opération a réellement
franchi une frontière d'engagement fournisseur. Il ne qualifie aucun conflit local.

---

# 34. Validations déterministes

Ensemble **fermé**, trente-trois contrôles.

| # | Contrôle | Valide | Ne valide pas |
|---|---|---|---|
| `V01` | forme d'identité canonique | l'aller-retour | l'existence |
| `V02` | existence de la controverse cible | la cible existe | qu'elle mérite une réconciliation |
| `V03` | périmètre présent et non vide **sur les enregistrements porteurs** (§6.1) ; absent sur une réponse | `SCOPE_REQUIRED`, `EMPTY_SCOPE = INVALID` | la pertinence |
| `V04` | énumération sans doublon | l'unicité | l'importance |
| `V05` | appartenance des unités à la cible | le rattachement | le contenu |
| `V06` | existence des unités dans l'instantané | la présence | l'exactitude |
| `V07` | `WHOLE` énuméré sous verrou | la complétude à la révision observée | une couverture future |
| `V08` | origine sémantique dans l'union fermée | la valeur | l'identité de l'auteur |
| `V09` | dérivation ⟺ origine `CCR` | l'équivalence stricte | la qualité de l'inférence |
| `V10` | effets réservés à `RECONCILIATION_RECORDED` | qu'une proposition et une réponse n'en portent aucun | — |
| `V11` | fournisseur absent des champs d'origine | la séparation d'attribution | — |
| `V12` | contenu humain présent sur tout acte humain | `content` non vide | sa justesse |
| `V13` | `provenance` présente et de type fermé | l'auditabilité | **aucune autorité** |
| `V14` | préconditions de clôture (§16.2) | les sept conditions | que la clôture soit justifiée |
| `V15` | préconditions de retrait (§21.2) | les neuf conditions | que le retrait soit justifié |
| `V16` | existence et nature des clôtures visées | qu'elles existent et déclarent une clôture | leur bien-fondé |
| `V17` | `withdrawal_scope` ⊆ périmètre de l'acte de retrait | l'inclusion | — |
| `V18` | `withdrawal_scope` ⊆ périmètre de chaque clôture visée | l'inclusion | — |
| `V19` | `withdrawn_closures` non vide, sans doublon | la désignation non ambiguë | — |
| `V20` | relation de supersession à périmètre explicite non vide | la déclaration | l'intention |
| `V21` | `supersession_scope` ⊆ périmètre de l'acte superseding | l'inclusion | — |
| `V22` | `supersession_scope` ⊆ périmètre de l'acte superseded | l'inclusion | — |
| `V23` | acte superseded existant, humain, même cible | la référence | son bien-fondé |
| `V24` | absence d'auto-supersession | l'irréflexivité | — |
| `V25` | acyclicité **par unité** (§18.5) | la déterminabilité par unité | — |
| `V26` | pas de doublon de `superseded_act_id` dans un acte | l'unicité des relations | — |
| `V27` | existence de la proposition référencée | la référence | son contenu |
| `V28` | relation à la proposition dans l'union fermée, option existante si `ADOPTS` | la forme | la valeur de l'option |
| `V29` | représentation des options non classée | l'absence de rang ou de score | — |
| `V30` | absence de champ de mérite | qu'aucun champ du §26.1 ne figure | — |
| `V31` | fraîcheur revérifiée sous verrou | la concordance d'état | — |
| `V32` | bornes d'écriture, schéma et version, sortie modèle stricte | la forme | le fond |
| `V33` | référence d'option d'une réponse (§13.5) | que la proposition existe, que l'option existe **dans cette proposition**, et qu'aucune référence croisée n'est admise | la valeur de l'option, et **aucun effet** |

```text
DETERMINISTIC VALIDATION  ≠  MERITS VALIDATION
```

Aucun contrôle n'établit qu'une réconciliation est correcte, qu'une clôture ou un
retrait sont opportuns, ou qu'une proposition est bonne.

---

# 35. Assistance par modèle

## 35.1 Conditions cumulatives

```text
1  un geste humain explicite déclenche la demande — rien ne la déclenche seul
2  l'appel reste sous la gouvernance d'usage déjà établie
3  la provenance de l'inférence est conservée
4  les entrées réellement soumises sont identifiables et enregistrées
5  toutes les préconditions déterministes sont revalidées avant persistance
```

## 35.2 Interdits

```text
NO RANKING     NO SCORE            NO CLOSURE       NO CLOSURE WITHDRAWAL
NO REOPENING   NO SUPERSESSION     NO DECISION      NO TRUTH CLAIM
NO CURRENTNESS EFFECT              NO AUTHORITY BASIS À EFFET AUTORITAIRE
```

## 35.3 Attribution et liaison

```text
MODEL_ASSISTED  ≠  SEMANTIC_ORIGIN      PROVIDER  ≠  SEMANTIC_ORIGIN
EXISTE MAINTENANT  ≠  A ÉTÉ SOUMIS
```

Un objet apparu pendant l'appel ne devient jamais rétroactivement une entrée
soumise.

## 35.4 Contexte de proposition assistée

```text
POLITIQUE DE CONTEXTE  =  CONTEXTE CANONIQUE EXPLICITE
```

Une proposition assistée **ne peut pas** être demandée à partir d'identifiants
opaques seuls. Le modèle reçoit un contexte sémantique explicite, canonique,
borné et auditable, restreint au périmètre soumis.

Pour **chaque entrée de controverse réellement soumise**, le contexte porte :

```text
controversy_id        identité de la controverse visée
entry_id              identité canonique de l'entrée
kind                  classe de l'entrée
semantic_origin       l'origine, jamais un mérite
content               l'énoncé canonique lui-même
anchors.provenance[]  ancrages canoniques : event_id, round
anchors.textual       lorsqu'il existe : event_id, quoted_text, occurrence
anchors.semantic      lorsqu'il existe : text, semantic_origin
```

`content` est le champ qui porte l'énoncé : c'est lui, et non une paraphrase, qui
est transmis. Aucun champ n'est reformulé, corrigé, complété ni normalisé au
passage.

Deux compléments accompagnent ces entrées, et rien d'autre :

```text
ÉVÉNEMENTS ANCRÉS      les événements canoniques réellement ancrés par une
                       entrée soumise — jamais un événement voisin, jamais
                       une entrée par proximité de journal

ADDUCTIONS ET LEURS    les adductions dont la CIBLE est une unité soumise,
MATÉRIAUX              et les matériaux que ces adductions mobilisent
                       une adduction visant une autre unité de la même
                       controverse reste dehors
```

```text
CONTENU D'ENTRÉE SOUMISE      REQUIS
CONTENU D'ÉVÉNEMENT ANCRÉ     REQUIS LORSQU'IL S'APPLIQUE
CONTEXTE D'ADDUCTION          REQUIS LORSQU'IL EXISTE
```

L'absence d'adduction est un fait ordinaire, jamais un manque à combler.

### Champs transmis pour une adduction

Pour **chaque adduction visant une unité soumise**, le contexte porte ses champs
canoniques, et eux seuls :

```text
entry_id            identité canonique de l'adduction
target.kind         la sorte de cible
target.entry_id     l'unité soumise visée
orientation         la valeur déclarée : NONE | SUPPORTS | OBJECTS_TO
citation            lorsqu'elle existe
material_id         le matériau mobilisé
```

Le matériau correspondant accompagne l'adduction, **selon sa forme de
représentation** et jamais au-delà :

```text
RUN_EVENT           representation.event_id
                    + le contenu canonique de l'événement, sauf s'il figure
                      déjà au titre des événements ancrés

INLINE_TEXT         representation.text

EXTERNAL_REFERENCE  representation.locator
                    representation.declared_digest lorsqu'il existe
                    et rien d'autre — métadonnées seules
```

Trois interdits, qui découlent directement de ce que CCR détient :

```text
RÉSOLUTION AUTOMATIQUE D'UNE RÉFÉRENCE EXTERNE   INTERDITE
ACCÈS RÉSEAU IMPLICITE                           INTERDIT
CONTENU EXTERNE INVENTÉ                          INTERDIT
```

CCR transmet ce qu'il détient réellement. Une référence externe est transmise
comme une référence, jamais comme un contenu.

### Ce que ce contexte n'établit pas

Ces énoncés appartiennent au contrat de contexte lui-même : ils contraignent la
lecture de ce qui est transmis, et ne s'appuient sur aucune règle située
ailleurs dans le dépôt.

```text
ADDUCTION        ≠  VÉRITÉ
ADDUCTION        ≠  VALIDATION DU FOND
PLUS DE MATÉRIAUX ≠  ARGUMENT PLUS FORT
RÉTENTION        ≠  ADDUCTION
```

L'orientation est une **position déclarée dans le débat** par l'acteur qui a
versé la pièce :

```text
ORIENTATION  =  position déclarée
ORIENTATION  ≠  jugement de CCR
```

Aucun de ces énoncés ne classe, ne pondère ni ne valide un matériau. Ils disent
seulement ce que la présence d'une pièce au contexte ne permet pas de conclure.

### Périmètre et contexte ne sont pas le même objet

```text
PÉRIMÈTRE  ≠  CONTEXTE
```

Le périmètre dit **sur quoi** la proposition porte ; le contexte dit **ce que le
modèle a lu**. Le second est calculé depuis le premier et ne l'élargit jamais :
une unité hors du périmètre soumis n'entre pas dans le contexte, et une unité
présente au contexte ne devient pas pour autant une unité visée.

### Instantané unique

```text
MÊME INSTANTANÉ  =  REQUIS
```

Toutes les unités de contexte d'une proposition sont observées depuis **un seul
instantané autoritaire et cohérent**. Un contexte assemblé depuis des révisions
sans rapport est interdit : il présenterait comme coexistants des faits qui ne
l'ont peut-être jamais été — exactement la vue que le protocole d'instantané
stable existe pour interdire.

Conséquence directe : le contexte n'est jamais recomposé morceau par morceau au
fil des lectures, ni complété après coup.

### Borne de taille

```text
CONTEXTE MAXIMAL  =  131072 octets UTF-8
```

La borne porte sur la **même chaîne canonique** que celle qui est mesurée,
condensée et transmise — jamais sur une approximation.

Au-delà, le refus est **déterministe et antérieur à tout engagement** :

```text
TRONCATURE SILENCIEUSE   INTERDITE
RÉSUMÉ AUTOMATIQUE       INTERDIT
```

Le système ne réduit pas le contexte en silence pour laisser ensuite croire que
la proposition a vu l'ensemble canonique. Constater le dépassement n'est pas y
remédier : le contrat refuse, et ne choisit à la place de personne ce qu'il
faudrait retirer.

### Ordre canonique du contexte

Le contexte préserve l'**ordre autoritaire de ses sources**, tel que le même
instantané et les read models propriétaires le rendent. Chaque famille garde
l'ordre de son propre journal.

```text
AUCUNE RECONSTRUCTION CÔTÉ CLIENT
AUCUN RECLASSEMENT CÔTÉ SERVICE
```

Aucun ordre total inter-journaux n'est fabriqué : les autorités n'en définissent
pas, et le contexte n'en invente pas. Les ordres locaux subsistent, côte à côte.

L'ordre est une propriété de journal, jamais un jugement :

```text
ORDRE  ≠  IMPORTANCE  ≠  PRÉFÉRENCE  ≠  POIDS  ≠  MÉRITE
```

### Auditabilité du contexte

Quatre faits sont journalisés — **jamais le contexte lui-même** :

```text
proposal_context_version   la règle de composition et de sérialisation employée
context_source_ids         les identités réellement retenues, nommément
context_utf8_bytes         la mesure exacte de la chaîne transmise
context_sha256             l'empreinte de cette même chaîne
```

La version de contexte identifie la règle de sélection et de sérialisation, non
un schéma persisté : deux contextes portant la même version et les mêmes sources
produisent le même condensat.

Les trois autres portent sur **exactement** la chaîne canonique transmise.
Mesurer une représentation et en transmettre une autre rendrait l'audit
décoratif.

Ces métadonnées établissent **ce que CCR a soumis**, et rien d'autre :

```text
elles n'établissent ni la vérité, ni le fond, ni la qualité
elles ne confèrent aucune autorité à la sortie du modèle
```

`context_source_ids` dit **ce qui a été lu** ; les entrées de dérivation disent
ce qui a été **soumis**. Aucun des deux ne se déduit de l'autre, et rien ne les
confond.

```text
PERSISTANCE DU PROMPT BRUT   NON REQUISE
                             NON AUTORISÉE PAR DÉFAUT
```

Le condensat et les identités suffisent à établir ce qui a été transmis ;
conserver le texte intégral ajouterait une surface de rétention que rien
n'exige.

### Contexte interdit

Ne sont jamais injectés automatiquement :

```text
tout le run                     les autres controverses
les entrées non soumises        les événements sans ancrage pertinent
les matériaux non adduits       des fichiers arbitraires du workspace
des secrets                     des variables d'environnement
la configuration fournisseur    la mémoire d'une session native
                                des données découvertes par exploration libre
```

```text
CONTEXTE DE RUN NON RELIÉ            = INTERDIT
DÉCOUVERTE DE WORKSPACE COMME CONTEXTE = NON AUTORISÉE
```

Une proposition doit pouvoir être comprise **à partir du contexte explicitement
fourni**, et de rien d'autre.

### Session

```text
POLITIQUE DE SESSION  =  SESSION FRAÎCHE
```

Le chemin assisté n'emprunte pas la session native d'un expert.

**Motif normatif.** La continuité cognitive implicite d'une session experte ne
doit pas remplacer un contexte épistémique explicite et auditable. Ce qu'un modèle
« se rappelle » n'est ni énumérable, ni bornable, ni vérifiable, ni
reproductible ; ce que CCR transmet l'est.

```text
SESSION NATIVE        ≠  AUTORITÉ DE CONTEXTE
CONTINUITÉ COGNITIVE  ≠  CONTINUITÉ ÉPISTÉMIQUE
```

Cette politique est **de périmètre** : elle vaut pour la proposition assistée de
réconciliation, et pour elle seule. Elle ne s'étend pas d'elle-même aux autres
inférences assistées.

### Ce que le contexte ne déplace pas

```text
DONNER À LIRE  ≠  DONNER AUTORITÉ
CONTEXTE       ≠  MANDAT
```

L'absence de juge automatique demeure intégralement.

### Sortie valide et vide

```text
VALID_ZERO  =  sortie structurellement valide contenant zéro proposition
```

```text
VALID_ZERO  ≠  consensus  ≠  accord  ≠  échec
VALID_ZERO  ≠  vérité     ≠  décision
VALID_ZERO  ≠  preuve que le contexte était suffisant
```

Elle dit ce qu'elle a toujours dit : la sortie était valide, et vide.

---

# 36. Sortie modèle stricte

```text
borne d'octets vérifiée AVANT l'analyse
enveloppe fermée, version explicite
ensemble de propositions clos
aucune valeur inconnue tolérée
```

Motifs de refus déterministes :

```text
sortie trop volumineuse       options classées
sortie non analysable         champ de score présent
version non prise en charge   clôture revendiquée
enveloppe invalide            retrait de clôture revendiqué
proposition invalide          supersession revendiquée
proposition dupliquée         décision humaine revendiquée
cible inconnue                effet autoritaire quelconque revendiqué
périmètre invalide
```

Chaque motif est refusé **avant** toute écriture. La rédaction des invites
appartient au plan.

**Un modèle peut proposer du contenu de réconciliation ; il ne peut jamais
pré-écrire un effet humain.**

---

# 37. Engagement fournisseur

```text
décision métier définitive → contrôle de politique / quota
→ allocation d'une identité d'invocation → écriture durable de l'engagement
→ tentative fournisseur
```

```text
ENGAGEMENT                 ≠  SUCCÈS
UNKNOWN_AFTER_COMMITMENT   ≠  PROVIDER_FAILED
USAGE FOURNISSEUR          ≠  MÉRITE DE LA PROPOSITION
```

Aucun rejeu automatique, aucune restitution automatique de budget.

---

# 38. Issues contrôlées

## 38.1 Acte humain

```text
RECORDED              l'acte est écrit ; les effets déclarés s'appliquent
REFUSED_VALIDATION    un contrôle de §34 a échoué — aucun acte écrit
REFUSED_FRESHNESS     révision périmée — aucun acte écrit
REFUSED_LOCK          un autre processus mute le run — aucun acte écrit
```

## 38.2 Détection déterministe

```text
PRODUCED · NOT_AVAILABLE · REFUSED_SNAPSHOT
```

## 38.3 Proposition CCR déterministe

```text
RECORDED · VALID_ZERO · REFUSED_VALIDATION
```

## 38.4 Proposition assistée par modèle

```text
RECORDED · VALID_ZERO · NOT_AVAILABLE · INVALID_OUTPUT
REVALIDATION_REFUSED · PROVIDER_FAILED
```

`UNKNOWN_AFTER_COMMITMENT` n'est **pas une issue rendue** : c'est une lecture, à
partir de l'engagement présent et de l'absence d'effet persisté.

## 38.5 Sémantique de `RECORDED`

Le contrat n'emploie pas `SUCCESS`. `RECORDED` signifie exactement : un
enregistrement a été écrit. Ni que la réconciliation soit bonne, ni qu'elle soit
opportune.

---

# 39. Aucun effet en cas d'échec

Pour chacune de ces situations, **aucun acte canonique V5 n'existe** :

```text
échec de validation           refus de fraîcheur
sortie modèle malformée       refus de revalidation
échec fournisseur rendu       instantané instable
verrou indisponible           identité dupliquée
cycle de supersession         réponse à une proposition invalide
```

Et aucune ne produit :

```text
clôture · retrait de clôture · supersession · décision humaine
· mutation d'actualité de décision · mutation d'actualité d'effet
```

---

# 40. Surfaces publiques

```text
SURFACE INITIALE  =  CLI
```

| Surface | Statut |
|---|---|
| mutation humaine — acte, réponse, clôture, retrait, supersession | **CLI** |
| détection structurelle | **dérivée** |
| proposition CCR déterministe | **CLI** |
| proposition assistée par modèle | **CLI** |
| read model | **exposé** |
| mutation HTTP | **exposée** (§43) |
| présentation cockpit | **exposée** (§42) |

Chaque surface porte les mêmes règles : le transport ne crée aucune autorité.

```text
SURFACE  ≠  BUSINESS AUTHORITY
```

---

# 41. Override humain réel

Les quatre opérations doivent être **réellement** disponibles :

```text
ACCEPT   REJECT   MODIFY   REPLACE
```

L'humain doit pouvoir produire un acte de réconciliation **sans qu'aucune
proposition n'existe** : la surface `B` est indépendante de la surface `C`.

```text
INTERDIT   accept-only · acceptation par défaut · par expiration · par silence
INTERDIT   une surface où MODIFY / REPLACE ne permettrait pas de saisir un
           contenu humain propre
```

---

# 42. Cockpit

Le cockpit local présente la lecture V5 et offre les gestes humains. Aucune
propriété du contrat ne dépend de cette présentation : elle rend, elle ne décide
pas.

Elle ne fait jamais apparaître :

```text
une proposition CCR comme une décision
une actualité de décision comme une actualité d'effet
une clôture comme un consensus
une détection structurelle comme une erreur intellectuelle
```

---

# 43. HTTP

La lecture V5 est exposée par la projection additive. Les mutations humaines —
acte, réponse, proposition — disposent d'un chemin dédié, idempotent, dont
l'issue est un reçu d'opération.

Le transport ne porte aucune autorité : une surface HTTP ne crée, ne modifie et
n'infère aucun effet que le contrat n'accorde pas.

---

# 44. Exigences de preuve

| Classe | Couverture |
|---|---|
| `STATIC` | formes, unions fermées, absence des champs interdits, espaces d'identité |
| `FIXTURE` | `V01`–`V33`, les deux algorithmes d'actualité, la matrice de cas `A`–`E`, détections `D01`–`D08`, parseur strict, issues |
| `AUTOMATED_REAL_PROCESS` | verrou, fraîcheur, instantané instable, append concurrent |
| `REAL_NOW` | uniquement ce qui a été réellement observé |
| `MODEL REAL GATE` | uniquement lorsqu'une campagne consommant un fournisseur est explicitement autorisée |
| `NOT_TESTED` | tout le reste, motif obligatoire |

Aucune campagne fournisseur n'est prévue par ce contrat.

---

# 45. Propriétés à prouver

Toutes les propriétés de ce registre sont **normatives pour ce contrat** et
testables. Ce ne sont pas des propositions doctrinales transversales : pour
celles-ci, voir [`../doctrine.md`](../doctrine.md).

```text
P01  une proposition ne peut pas clore
P02  une détection ne peut pas clore
P03  une sortie modèle ne peut pas clore
P04  une origine non humaine ne peut pas superséder
P05  une origine non humaine ne peut pas produire E
P06  le périmètre est toujours explicite
P07  le périmètre ne sort jamais de la controverse cible
P08  WHOLE n'est jamais une absence
P09  une clôture partielle reste partielle
P10  une clôture de périmètre WHOLE exige WHOLE explicite + clôture explicite
P11  une supersession ne réécrit jamais l'acte antérieur
P12  la récence n'implique jamais la supersession
P13  une contradiction n'implique jamais la supersession
P14  l'actualité de décision est dérivée
P15  plusieurs actes courants peuvent coexister sans supersession
P16  les options d'une proposition ne sont pas classées
P17  un ordre ne signifie jamais une préférence
P18  une réponse humaine crée un acte humain nouveau
P19  le fournisseur ne devient jamais origine sémantique
P20  l'assistance modèle ne devient jamais autorité
P21  aucun score de mérite n'existe
P22  aucun gagnant n'existe
P23  aucun état CONVERGED n'existe
P24  aucun état canonique de désaccord persistant n'existe
P25  l'absence de clôture n'implique pas le désaccord
P26  une clôture n'efface pas l'historique du désaccord
P27  superseded ne signifie pas faux
P28  une vue dérivée ne crée pas d'acte historique
P29  une validation déterministe ne valide pas le fond
P30  une présentation ne devient pas une autorité métier
P31  un périmètre vide est refusé
P32  un périmètre WHOLE est énuméré ; une entrée ultérieure n'y entre jamais
P33  aucune relation ni aucun effet n'hérite du périmètre d'un autre
P34  une décision legacy sans périmètre ne devient jamais une autorité scopée
P35  un effet n'existe que s'il est déclaré explicitement sur l'acte
P36  une supersession seule ne retire jamais une clôture
P37  un retrait de clôture exige un acte humain explicite
P38  un retrait de clôture est scopé
P39  un retrait de clôture n'efface pas l'historique
P40  actualité de décision et actualité d'effet sont indépendantes
P41  le périmètre d'une supersession est déclaré, jamais inféré par intersection
P42  l'acyclicité est vérifiée par unité de périmètre
P43  la relation de supersession n'est pas implicitement transitive
P44  superséder un superséder ne ressuscite pas l'acte antérieur
P45  une réponse ACCEPT seule ne produit aucun effet autoritaire
P46  `provenance` ne confère aucune autorité
P47  une déclaration historique de périmètre WHOLE n'implique pas une couverture
     actuelle complète
P48  aucune réouverture implicite n'existe
P49  une réponse à une proposition ne porte aucun périmètre, et rien n'en dérive
     un périmètre d'effet
P50  une référence d'option portée par une réponse est validée et sans effet ;
     elle ne vaut jamais adoption
```

```text
Pxx COUNT = 50
```

---

# 46. Critères d'acceptation

| # | Critère |
|---|---|
| `C01` | les trois classes d'enregistrement existent, distinctes et discriminées |
| `C02` | l'identité `rcn_` est canonique, unique et immuable |
| `C03` | l'espace d'identité V5 est disjoint des espaces V1–V4 |
| `C04` | toute cible est une `ctv_`, et une seule |
| `C05` | un acte sans périmètre est refusé |
| `C06` | un périmètre vide est refusé |
| `C07` | une unité étrangère à la cible est refusée |
| `C08` | `WHOLE` est enregistré comme énumération, avec son marqueur |
| `C09` | une entrée créée après l'acte n'est jamais couverte |
| `C10` | l'union d'origine sémantique est fermée à deux valeurs |
| `C11` | une dérivation existe si et seulement si l'origine est `CCR` |
| `C12` | une proposition ne porte aucun effet ni aucune provenance d'autorité |
| `C13` | les options sont non classées et sans champ de score |
| `C14` | une clôture exige les sept préconditions du §16.2 |
| `C15` | un retrait de clôture exige les neuf préconditions du §21.2 |
| `C16` | un retrait désigne explicitement les clôtures retirées |
| `C17` | une supersession exige les neuf préconditions du §18.2 |
| `C18` | chaque relation de supersession porte son propre périmètre déclaré |
| `C19` | le périmètre d'une relation est validé comme inclus dans les deux actes |
| `C20` | l'auto-supersession est refusée |
| `C21` | l'acyclicité est vérifiée par unité `ctve_`, non globalement |
| `C22` | des relations réciproques sur unités disjointes sont acceptées |
| `C23` | l'actualité de décision suit l'algorithme du §19.1, sans horloge |
| `C24` | un acte antérieur ne redevient jamais courant |
| `C25` | plusieurs actes courants sur une unité sont rendus comme un ensemble |
| `C26` | l'actualité d'effet de clôture suit l'algorithme du §20.3 |
| `C27` | la supersession n'est pas une entrée du calcul d'effet de clôture |
| `C28` | les cinq cas de la matrice §21.5 produisent le résultat spécifié |
| `C29` | `historical_explicit_whole_scope_closure_declaration` et `current_all_entries_closure_coverage` sont deux champs distincts |
| `C30` | une réponse `ACCEPT` ou `REJECT` ne porte aucun effet |
| `C31` | tout acte humain porte un `content` humain non vide |
| `C32` | `ADOPTS`, `MODIFIES`, `REPLACES` ont trois sémantiques distinctes |
| `C33` | `provenance` est obligatoire et sans effet sur l'autorité |
| `C34` | une décision legacy ne satisfait jamais une condition d'autorité |
| `C35` | une autorité V3 est référençable, jamais dupliquée ni fusionnée |
| `C36` | la vue du désaccord n'expose que les signaux `S1`–`S4` |
| `C37` | aucun champ ni valeur `CONVERGED` n'existe |
| `C38` | aucun champ du §26.1 n'existe dans le schéma |
| `C39` | le journal V5 distingue absent et présent-vide dans sa révision |
| `C40` | la révision V5 n'est jamais comparée à une autre |
| `C41` | le journal V5 est observé dans l'instantané stable |
| `C42` | une révision périmée est refusée, jamais complétée |
| `C43` | le verrou n'est jamais tenu pendant un appel fournisseur |
| `C44` | les trente-trois validations du §34 sont implémentées et fermées |
| `C45` | le parseur strict refuse chacun des motifs du §36 avant écriture |
| `C46` | aucune situation d'échec ne produit d'effet |
| `C47` | les quatre opérations d'override sont réellement disponibles |
| `C48` | un acte humain peut être produit sans qu'aucune proposition existe |
| `C49` | aucune surface ne trie ni ne réordonne une séquence canonique |
| `C50` | le read model distingue les cinq catégories du §24.3 |
| `C51` | le read model n'agrège jamais les deux actualités |
| `C52` | un run non concerné rend `NOT_AVAILABLE`, sans compteur |
| `C53` | une réponse à une proposition ne porte ni `scope_kind`, ni `scope`, ni `content` |
| `C54` | `responded_option_id` et `adopted_option_id` sont deux champs distincts, et le premier est validé sans produire d'effet |

```text
Cxx COUNT = 54
```

---

# 47. Migration

```text
MIGRATION = NO
```

Aucun journal V3 ou V4 n'est muté. Aucun objet historique ne reçoit
rétroactivement un périmètre, une supersession, une clôture ou un retrait.

```text
UNKNOWN reste UNKNOWN        RÉFÉRENCE  ≠  CONVERSION
```

---

# 48. Historicité locale

```text
Les enregistrements du journal V5 ne sont pas réécrits.
Une correction est un enregistrement nouveau, qui référence l'antérieur.
```

L'état dérivé — les deux actualités, la vue du désaccord — change sans qu'aucun
acte historique ne soit modifié. Règle **locale au journal V5** : elle ne pose pas
que tout état CCR serait append-only.

---

# 49. Ce que ce contrat ne couvre pas

Certaines capacités n'ont **aucun objet canonique** : une cible autre qu'une
controverse, par exemple. Leur absence est un constat de périmètre, pas un
interdit.

D'autres sont **explicitement non autorisées**, et le resteront tant qu'une
décision humaine ne les ouvre pas :

```text
pondération probatoire                 classement de propositions
gagnant · énoncé ou preuve préférés    vérité du fond
cycle de vie OPEN / CLOSED / REOPENED
état canonique de désaccord persistant
```

`CONVERGED` n'est ni interdit ni promis : il est **réservé** (§23).
