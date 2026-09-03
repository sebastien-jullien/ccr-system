# CCR — Spécification · Inventaire machine des runs

```text
STATUT                          contrat courant
PORTÉE                          inventaire machine public · lecture seule
CONTRAT D'INVENTAIRE DE RUNS    1
```

Ce document définit la structure et la portée de l'inventaire machine produit
par `ccr list --format json`.

---

# 1. Objet représenté

```text
OBJET   l'identité de run DÉCOUVRABLE
```

Une identité de run est représentée **si et seulement si** l'autorité
d'énumération des runs la reconnaît comme découvrable.

## 1.1 Ce que la représentation affirme

```text
cette identité de run est découvrable par l'autorité d'énumération
```

Et rien de plus.

## 1.2 Ce qu'elle n'affirme pas

```text
≠ le manifest du run est lisible
≠ son state est lisible
≠ manifest et state sont cohérents entre eux
≠ le run est valide
≠ son initialisation a réussi
≠ un état d'exécution quelconque
≠ READY
≠ succès          ≠ échec
≠ santé           ≠ complétion         ≠ maturité
≠ disponibilité d'un fournisseur
≠ existence d'un fait d'issue d'invocation
≠ réconciliation
≠ statut ou capacité générale du run
```

**La lisibilité des documents d'un run n'est pas une condition d'inclusion.**
Un manifest ou un state absent, illisible, incohérent ou portant une version
inconnue ne retire pas une identité par ailleurs découvrable.

Les issues de lecture de ces documents sont **hors** de la sémantique de cet
inventaire : elles n'y apparaissent sous aucune forme.

---

# 2. Relation à l'autorité d'énumération

```text
                autorité d'énumération des runs
                       ↙            ↘
        `ccr list` humain      inventaire machine
```

Les deux surfaces descendent de la même autorité. L'inventaire machine **n'est
pas** une traduction de la sortie humaine, et la sortie humaine **n'est pas**
une autorité normative pour la machine.

La sortie humaine de `ccr list` repose sur un modèle de lecture plus large, qui
ouvre des documents par run. L'inventaire machine ne les ouvre pas. Les deux
peuvent donc légitimement dire des choses différentes d'un même run : l'un
décrit ce qu'il a pu lire, l'autre uniquement ce qui est découvrable.

---

# 3. Frontière succès / échec

```text
SUCCÈS   énumération complète et fiable
         code de sortie 0
         stdout = exactement un document JSON complet

ÉCHEC    l'énumération ne peut pas aboutir de façon fiable
         code de sortie non nul
         AUCUN document d'inventaire abouti sur stdout
```

```text
ÉCHEC D'ÉNUMÉRATION   ≠   { "runs": [] }
```

Un échec ne devient jamais un inventaire vide.

Il n'existe **pas** d'inventaire machine partiel abouti, et **pas** d'objet
d'erreur structuré dans ce contrat. Le diagnostic humain existant sur `stderr`
est permis, et non normatif.

Un consommateur n'analyse `stdout` qu'après un code de sortie `0`.

La taxonomie exacte des causes de sortie non nulle n'est pas étendue ici.

---

# 4. Document

Objet JSON plat.

```json
{
  "run_inventory_contract_version": 1,
  "runs": [
    { "run_id": "…" }
  ]
}
```

Le producteur du contrat v1 émet exactement ces champs de premier niveau, et
eux seuls :

| Champ | Rôle |
|---|---|
| `run_inventory_contract_version` | version de structure de ce document |
| `runs` | collection des identités découvrables |

Et exactement ce champ par entrée :

| Champ | Rôle |
|---|---|
| `run_id` | l'identité de run découvrable, **chaîne opaque** |

Aucun autre fait d'inventaire n'est autorisé — en particulier ni statut, ni
état, ni titre, ni génération, ni horodatage, ni workspace, ni contrôle, ni
round, ni identité active, ni issue de lecture, ni compte.

## 4.1 `run_id` est opaque

La forme actuelle d'un identifiant de run n'est **pas** une interface machine.
Ni sa partie date, ni sa partie ordinale, ni le motif qui les valide ne
constituent un contrat : un consommateur traite la valeur comme une chaîne
opaque, et ne l'analyse pas.

---

# 5. Complétude et unicité

Pour toute énumération complète et aboutie :

```text
chaque identité découvrable   →  exactement une entrée
chaque entrée                 →  exactement une identité découvrable
```

Une entrée `run_id` en double est une sortie de producteur invalide. Une
identité découvrable omise l'est également.

Le nombre d'identités représentées est la longueur de `runs`. Aucun champ de
compte indépendant n'existe — il pourrait diverger.

---

# 6. Contexte d'énumération

L'inventaire porte sur le **contexte d'énumération résolu de l'invocation**.

`--runs-dir` est l'entrée de contexte existante.

Le chemin physique d'énumération n'est **pas** représenté : ni `runs_dir`, ni
source, ni provenance, ni chemin de workspace, ni donnée de résolution du
chemin par défaut.

```text
DOCUMENT MACHINE  =  volontairement non auto-descriptif
                     quant à l'emplacement physique d'énumération
```

Deux inventaires produits dans deux contextes différents ne se distinguent donc
pas par leur contenu. C'est délibéré : le contexte appartient à l'appelant, qui
le connaît déjà.

---

# 7. Zéro

Une énumération complète et aboutie ne trouvant aucune identité rend :

```json
{
  "run_inventory_contract_version": 1,
  "runs": []
}
```

avec un code de sortie `0`.

Un répertoire de runs absent est, pour l'autorité d'énumération, une
énumération aboutie à zéro identité. Il produit donc **le même résultat public**
qu'un répertoire présent et vide, et le contrat n'expose pas cette distinction
physique.

```text
ZÉRO  ≠  succès de run
      ≠  échec de run
      ≠  santé
      ≠  complétion
      ≠  absence de toute activité CCR passée
```

---

# 8. Ordre

L'ordre d'énumération courant traverse tel quel. Le sérialiseur n'introduit
aucun tri.

```text
CONTRAT v1   AUCUNE garantie d'ordre sémantique
```

La position dans le tableau n'implique ni chronologie, ni récence, ni priorité,
ni ordre de création, ni ordre d'exécution. Un consommateur qui a besoin d'un
ordre l'établit lui-même, à partir d'une autorité qui le porte.

---

# 9. Version

```text
run_inventory_contract_version   1
```

Axe public **unique** de ce contrat.

Ne sont pas des discriminants de protocole, et n'apparaissent pas dans le
document :

```text
version du paquet CCR
version de schéma du manifest
version de schéma du state
génération d'exécution
```

Ces versions gouvernent des documents internes ou une distribution ; aucune ne
dit comment lire ce document.

Ce contrat ne documente ni sémantique d'état, ni sémantique de génération —
le fait que la sortie humaine de `ccr list` les affiche n'en fait pas des
concepts de cet inventaire.

## 9.1 Ce que la version gouverne

`run_inventory_contract_version` gouverne la structure : champs admis, leur
imbrication, et la frontière succès / échec de ce document.

Exigent une évolution explicite de cette version :

```text
réaffectation du rôle d'un champ
retrait d'un champ requis
renommage rompant le contrat
réinterprétation structurelle matériellement incompatible
changement du contrat de complétude, d'unicité ou de résultat vide
```

## 9.2 Ce qui n'est pas décidé

```text
JEU DE CHAMPS DU PRODUCTEUR COURANT
  ≠  POLITIQUE DE CONSOMMATION D'UN CHAMP INCONNU FUTUR
```

Ne sont **pas** définis par le contrat v1 :

```text
champs optionnels futurs
champs supplémentaires inconnus
compatibilité ascendante
politique de compatibilité additive
```

Un consommateur ne peut rien déduire de ce document quant au sort d'un champ
qu'il ne connaîtrait pas.

---

# 10. Exclusions explicites

N'apparaissent jamais dans un inventaire machine :

```text
statut · état · succès · échec · santé · complétion · maturité
titre · génération · horodatage · workspace · contrôle · round
identité active · issue de lecture d'un document de run
compte · chemin ou état physique du répertoire de runs
prose humaine de présentation
```

Aucune persistance n'est exposée comme API.

---

**Un inventaire n'est pas un état.** Ce document dit ce que CCR peut trouver ;
il ne dit rien de ce que CCR y a fait, ni de ce qui s'y est passé.
