# CCR — Spécification · Représentation machine des issues d'invocation

```text
STATUT                              contrat courant
PORTÉE                              représentation machine publique · lecture seule
CONTRAT DE REPRÉSENTATION MACHINE   1
CONTRAT SÉMANTIQUE SUPPORTÉ         1
VERSIONS D'ENREGISTREMENT SOURCE    1 · 2
```

Ce document définit la **structure** de la représentation machine produite par
`ccr invocation-outcomes --format json`, et le rôle machine de chacun de ses
champs.

---

# 1. Autorité et portée

## 1.1 Ce que ce document possède

```text
CE DOCUMENT   la structure, et le rôle machine des champs
```

Il ne possède **aucune** signification de jeton public. Le sens de
`VALID_ZERO`, des genres négatifs, des motifs, des contrôles et des champs de
charge utile appartient au contrat sémantique :

```text
SIGNIFICATION DES JETONS  →  docs/specs/invocation-outcome.md
VALID_ZERO                →  docs/specs/invocation-outcome.md § 4.1
                             → docs/doctrine.md § 17.7
```

Aucune définition sémantique n'est recopiée ici.

## 1.2 Ce que la représentation est

Une **représentation alternative de la même autorité** — les faits dédiés
d'issue d'invocation déjà persistés. Elle n'ajoute aucun fait, aucune autorité,
aucun statut.

```text
≠ nouvelle autorité
≠ statut d'invocation
≠ vidage de persistance
≠ API de persistance
≠ agrégation inter-autorités
```

Aucune API machine n'existe hors de la CLI.

---

# 2. Combinaison supportée

```text
contrat de représentation machine   1
contrat sémantique                  1
versions d'enregistrement source    1 · 2
```

Quatre versions distinctes ne doivent pas être confondues :

```text
machine_representation_version   la structure de ce document
semantic_contract_version        le sens des jetons qu'il porte
source_record_version            la forme sous laquelle CE fait-là fut persisté
version du paquet CCR            n'est pas un discriminant de protocole,
                                 et n'apparaît pas dans le document
```

Les deux premières sont **indépendantes** : aucune n'est dérivée de l'autre, et
faire évoluer l'une n'oblige pas à faire évoluer l'autre.

Aucun registre. Aucune négociation. Aucun service de version à l'exécution.

---

# 3. Frontière succès / échec

```text
SUCCÈS   code de sortie 0
         stdout = exactement un document JSON complet,
         plus les seuls blancs de sérialisation

ÉCHEC    code de sortie non nul
         aucun document machine abouti sur stdout
         diagnostic humain existant sur stderr
```

```text
PROJECTION MACHINE COMPLÈTE
  OU
ÉCHEC AU NIVEAU DU PROCESSUS
```

Il n'existe **pas** de document machine partiel, et **pas** d'objet d'erreur
structuré dans ce contrat.

Un consommateur n'analyse `stdout` qu'après un code de sortie `0`.

Classes existantes conservées :

```text
0   projection complète et fiable
1   échec CCR ou lecture impossible
2   erreur d'usage CLI
```

Aucune sémantique de code de sortie par cause n'est ajoutée.

---

# 4. Objet de premier niveau

Objet JSON **plat**.

```json
{
  "machine_representation_version": 1,
  "semantic_contract_version": 1,
  "run_id": "…",
  "facts": []
}
```

Champs admis, et eux seuls :

| Champ | Rôle machine | Présence |
|---|---|---|
| `machine_representation_version` | version de structure de ce document | toujours |
| `semantic_contract_version` | version du contrat qui donne sens aux jetons portés | toujours |
| `run_id` | contexte de requête : le run résolu que le document représente | toujours |
| `invocation_filter` | contexte de requête : l'invocation sur laquelle la requête a été restreinte | **seulement si un filtre a été appliqué** |
| `facts` | collection ordonnée des faits | toujours |

Le producteur de la représentation machine v1 émet exactement ces champs, et eux
seuls. En particulier, il n'émet ni `status`, ni `success`, ni `error`, ni
`count`, ni `source`, ni `package_version`, ni `schema_version`, ni `authority`,
ni `reference` — ces exclusions sont des décisions produit, non des règles de
compatibilité.

```text
SORTIE DU PRODUCTEUR COURANT
  ≠  POLITIQUE DE COMPATIBILITÉ pour un champ optionnel ou inconnu futur
```

Ce paragraphe décrit ce que la version 1 **produit**. Il ne décide ni si un champ
optionnel pourra apparaître un jour, ni ce qu'un consommateur doit faire d'un
champ qu'il ne connaît pas. Voir § 12.

## 4.1 Contexte de requête

`run_id` et `invocation_filter` décrivent **la requête résolue**, jamais un
fait durable. Ils ne constituent aucune autorité.

La règle de résolution d'un argument de run omis **n'est pas contractualisée**
par ce document.

---

# 5. Collection de faits

```text
facts   tableau ORDONNÉ
ORDRE   ordre d'ajout persisté
```

Pour une projection complète et fiable :

```text
N faits dédiés   →  N faits machine
0 fait dédié     →  "facts": []  ·  code de sortie 0
```

Un tableau vide est une **cardinalité**. Il ne signifie pas :

```text
≠ succès d'invocation
≠ échec d'invocation
≠ VALID_ZERO
≠ UNKNOWN
≠ NOT_COMMITTED
```

Aucun enregistrement synthétique n'est jamais produit pour représenter le vide.

---

# 6. Structure d'un fait

```json
{
  "invocation_id": "…",
  "recorded_at": "…",
  "source_record_version": 2,
  "outcome": { "kind": "…" }
}
```

| Champ | Rôle machine |
|---|---|
| `invocation_id` | identifie l'invocation à laquelle le fait est attaché |
| `recorded_at` | valeur d'horodatage d'enregistrement, transmise verbatim |
| `source_record_version` | version de l'enregistrement source — `1` ou `2` |
| `outcome` | l'issue, en objet discriminé fermé |

Aucune métadonnée d'enveloppe de stockage n'apparaît dans un fait.

---

# 7. Représentation de l'issue

`outcome` est un **objet discriminé fermé**.

```text
kind   toujours présent — le genre public exact
```

Puis, et uniquement, les champs sémantiquement applicables à ce genre :

| Genre | Champs portés |
|---|---|
| `VALID_ZERO` | aucun |
| `V3_INVALID_OUTPUT` · `V4_INVALID_OUTPUT` · `V5_INVALID_OUTPUT` | `reason` · `at` |
| `V4_REVALIDATION_REFUSED` · `V5_REVALIDATION_REFUSED` | `check` · `detail` |
| `V3_PROVIDER_FAILED` · `V4_PROVIDER_FAILED` · `V5_PROVIDER_FAILED` | `error_code` si présent |
| `NATIVE_PROCESS_FAILED` | `error_code` si présent · `native_detail` si présent |

Il n'existe ni `data`, ni `payload`, ni sac générique, et aucun attribut de la
persistance n'est reporté automatiquement.

```text
UNION DE STOCKAGE   preuve d'implémentation
ISSUE MACHINE       représentation fermée, sérialisée explicitement
```

## 7.1 `native_detail`

Deux variantes fermées, chacune avec ses seuls membres applicables :

| `code` | Membres |
|---|---|
| `SESSION_ID_COLLISION` | `code` · `expert_slot` · `provider` · `session_id` |
| `AGENT_SESSION_MISMATCH` | `code` · `expert_slot` · `provider` · `expected_session_id` · `found_session_id` |

Aucun membre hors de la variante applicable. Aucun placeholder.

## 7.2 `VALID_ZERO`

```json
{ "kind": "VALID_ZERO" }
```

Et rien d'autre. Ni `success`, ni `status`, ni `count`, ni `reason`, ni
`payload`, ni glose.

```text
RÉSULTAT DE REQUÊTE VIDE   ≠   FAIT VALID_ZERO
```

Le premier est un tableau `facts` vide ; le second est un fait présent, portant
ce genre.

---

# 8. Absence

```text
ABSENCE  =  CLÉ OMISE
null     =  JAMAIS ÉMIS
```

S'applique à `invocation_filter`, `error_code`, aux champs propres à une
variante, à `native_detail`, et aux membres non applicables au `code` d'un
`native_detail`.

L'absence d'`error_code` conserve le sens que lui donne le contrat sémantique :
CCR ne connaît pas de code significatif. Émettre `"error_code": null`
transformerait cette ignorance déclarée en valeur rendue.

Aucune sémantique de `null` n'est introduite.

---

# 9. `recorded_at`

```text
TYPE SÉRIALISÉ   chaîne
VALEUR           celle que porte l'enregistrement, verbatim
```

La représentation machine **n'analyse pas** cette valeur, ne la reformate pas,
et n'y attache **aucune** promesse :

```text
NI RFC3339   NI ISO 8601   NI fuseau   NI précision
```

Sa signification — l'instant auquel CCR a enregistré le fait — appartient au
contrat sémantique.

---

# 10. Jetons, identifiants et texte libre

| Classe | Contrat |
|---|---|
| noms de champ · jetons d'énumération contrôlés | valeurs de contrat, indépendantes de la locale |
| identifiants (`run_id`, `invocation_id`, identifiants de session) | transmis verbatim |
| chaînes opaques (`at`, `recorded_at`, `error_code`, `check` V4) | transmises verbatim |
| texte libre orienté humain (`detail`) | transmis verbatim |

Aucune traduction. Aucune normalisation de locale. Aucune garantie de langue
sur les valeurs opaques ou de texte libre.

---

# 11. Exclusions explicites

N'apparaissent jamais dans un document machine :

```text
noms de stockage       outcomes · terminal_outcome
                       · terminal_negative_outcome
                       · schema_version de document
nom de fichier physique de la persistance
prose d'autorité · prose de pointeur · glose VALID_ZERO
énoncé humain de cardinalité nulle
statut · succès · échec · UNKNOWN · NOT_COMMITTED
agrégat · compte · taux · gravité
jointure registre · usage · transcript natif · objet de domaine
```

La persistance n'est pas exposée comme API.

---

# 12. Responsabilité de la version de représentation

`machine_representation_version` gouverne **la structure** : champs admis, leur
imbrication, la règle d'omission, et la frontière succès / échec de ce document.

```text
MÊME machine_representation_version   →  MÊME structure
```

Exigent une évolution explicite de cette version :

```text
réaffectation du rôle d'un champ
retrait d'un champ requis
renommage rompant le contrat
réinterprétation structurelle matériellement incompatible
changement du contrat de cardinalité ou de résultat vide
```

Ne sont **pas** définis par le contrat v1 :

```text
champs optionnels futurs
champs supplémentaires inconnus
compatibilité ascendante
politique de compatibilité additive
```

Un consommateur ne peut donc rien déduire de ce document quant au sort d'un
champ qu'il ne connaîtrait pas, et l'apparition éventuelle d'un champ optionnel
n'est ni promise ni exclue ici.

Elle ne gouverne **pas** le sens des jetons : celui-ci suit
`semantic_contract_version`, et une évolution sémantique n'entraîne pas
mécaniquement une évolution de structure.

Le mécanisme exact d'évolution de l'une ou l'autre version n'est pas choisi par
ce document.

---

# 13. Références d'autorité

| Sujet | Autorité |
|---|---|
| Signification des genres, motifs, contrôles et champs | [`docs/specs/invocation-outcome.md`](invocation-outcome.md) |
| `VALID_ZERO` | [`docs/specs/invocation-outcome.md`](invocation-outcome.md) § 4.1 → [`docs/doctrine.md`](../doctrine.md) § 17.7 |
| Invariants transverses | [`docs/doctrine.md`](../doctrine.md) |

---

**Une représentation n'est pas une autorité.** Ce document décrit une forme ;
ce qu'elle transporte reste ce que le contrat sémantique établit, et rien de
plus.
