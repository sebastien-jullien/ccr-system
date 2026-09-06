# CCR — Spécification · Découverte sémantique machine des runs

```text
STATUT                              contrat courant
PORTÉE                              découverte sémantique machine publique · lecture seule
CONTRAT SÉMANTIQUE SUPPORTÉ         1
CONTRAT DE REPRÉSENTATION MACHINE   1
```

Ce document définit la structure et la portée du document machine produit par
`ccr run-descriptors --format json`.

---

# 1. Autorité et portée

## 1.1 Ce que ce document possède

```text
L'ASSOCIATION PUBLIQUE AUTORITATIVE
  entre une identité de run découvrable, opaque,
  et le titre canonique enregistré de ce run
```

Et rien d'autre.

## 1.2 Surface publique

```text
ccr run-descriptors --format json [--runs-dir <répertoire>]
```

`--format json` est **obligatoire**. Ce contrat ne définit aucune présentation
humaine de cette commande, et aucune n'est promise.

## 1.3 Ce que la représentation affirme

```text
cette identité de run est découvrable par l'autorité d'énumération
ET
le titre canonique enregistré de ce run est celui rendu
```

## 1.4 Ce qu'elle n'affirme pas

```text
≠ le titre est vrai
≠ le titre est vérifié
≠ le titre est unique
≠ le titre décrit fidèlement le travail du run
≠ un état d'exécution quelconque
≠ succès          ≠ échec
≠ santé           ≠ complétion         ≠ maturité
≠ une activité, une invocation ou une issue
≠ une génération d'exécution
≠ un emplacement de workspace
```

---

# 2. Relation aux autorités voisines

```text
INVENTAIRE DE RUNS v1   autorité d'identité de run découvrable
CE CONTRAT              autorité de descripteur sémantique de run
```

Les deux surfaces descendent de la **même** autorité d'énumération. La notion
de « run découvrable » est identique dans les deux, et ce contrat n'en définit
aucune seconde.

```text
CE CONTRAT   ≠ remplacement de l'inventaire de runs v1
             ≠ réinterprétation de l'inventaire de runs v1
             ≠ version enrichie de l'inventaire de runs v1
```

Les deux documents restent séparés et lisibles indépendamment. Une projection
aboutie de ce contrat représente le même ensemble d'identités découvrables que
l'inventaire, mais leurs frontières de succès diffèrent — voir § 3 et § 6.

Autorité de l'identité de run découvrable :
[`docs/specs/run-inventory-machine.md`](run-inventory-machine.md).

---

# 3. Frontière succès / échec

```text
SUCCÈS   énumération complète et fiable
         ET titre établi avec autorité pour CHAQUE identité découverte
         code de sortie 0
         stdout = exactement un document JSON complet

ÉCHEC    l'énumération ne peut pas aboutir de façon fiable
         OU le titre d'au moins une identité découverte
            ne peut pas être établi avec autorité
         code de sortie non nul
         AUCUN document abouti sur stdout
```

```text
PROJECTION ABOUTIE PARTIELLE   INTERDITE
```

Un titre non établissable n'est ni omis, ni rendu nul, ni remplacé par une
valeur de repli. Il empêche **tout** le document : les descripteurs par ailleurs
établis ne traversent pas seuls.

```text
ÉCHEC   ≠   { "runs": [] }
```

Un échec ne devient jamais un résultat vide.

Il n'existe **pas** de document partiel abouti, et **pas** d'objet d'erreur
structuré dans ce contrat. Le diagnostic humain sur `stderr` est permis, et non
normatif.

Un consommateur n'analyse `stdout` qu'après un code de sortie `0`.

---

# 4. Discipline machine de la ligne de commande

```text
code de sortie 0
  → stdout = exactement un document JSON valide
  → aucune prose humaine sur stdout

code de sortie 1 · code de sortie 2
  → aucun document abouti ni partiel sur stdout
  → un diagnostic peut être écrit sur stderr
```

Une fin de ligne finale unique est sans sémantique.

---

# 5. Document

Objet JSON plat.

```json
{
  "semantic_run_discovery_contract_version": 1,
  "semantic_run_discovery_machine_representation_version": 1,
  "runs": [
    { "run_id": "…", "title": "…" }
  ]
}
```

Le producteur du contrat v1 émet exactement ces champs de premier niveau, et
eux seuls :

| Champ | Rôle |
|---|---|
| `semantic_run_discovery_contract_version` | version du contrat sémantique porté |
| `semantic_run_discovery_machine_representation_version` | version de structure de ce document |
| `runs` | collection des descripteurs |

Et exactement ces champs par descripteur :

| Champ | Rôle |
|---|---|
| `run_id` | l'identité de run découvrable, **chaîne opaque** |
| `title` | le titre canonique enregistré du run |

```text
JEU DE CHAMPS DU PRODUCTEUR v1   FERMÉ
```

## 5.1 `run_id` est opaque

La forme actuelle d'un identifiant de run n'est **pas** une interface machine.
Ni sa partie date, ni sa partie ordinale, ni le motif qui les valide ne
constituent un contrat : un consommateur traite la valeur comme une chaîne
opaque, et ne l'analyse pas.

```text
run_id   AUCUNE sémantique lexicale
         AUCUN ordre déductible
         AUCUNE date déductible
```

## 5.2 `title` est un fait enregistré, pas une vérité

`title` est le titre canonique tel qu'il a été enregistré pour ce run, rendu
**verbatim**. CCR ne le normalise pas, ne le tronque pas, ne le traduit pas et
n'en vérifie pas le contenu.

```text
title   =  ce qui a été enregistré
        ≠  une vérité sur le run
        ≠  une description validée
        ≠  un identifiant
```

## 5.3 L'unicité des titres n'est pas garantie

```text
UNICITÉ DES TITRES   NON GARANTIE
```

Deux runs peuvent porter le même titre. Ils restent **deux descripteurs
distincts**, et ce contrat n'élit aucun gagnant.

```text
TITRES EN DOUBLE   =  plusieurs candidats légitimes
                   =  aucun gagnant implicite
                   ≠  une erreur
                   ≠  un doublon à dédupliquer
```

Un consommateur qui sélectionne un run par son titre doit traiter la
multiplicité comme un cas normal, et lever l'ambiguïté par un moyen qui lui
appartient. L'identité, elle, reste `run_id`.

---

# 6. Complétude et unicité

Pour toute projection complète et aboutie :

```text
chaque identité découvrable   →  exactement un descripteur
chaque descripteur            →  exactement une identité découvrable
```

Un `run_id` en double est une sortie de producteur invalide. Une identité
découvrable omise l'est également.

Le nombre de descripteurs est la longueur de `runs`. Aucun champ de compte
indépendant n'existe — il pourrait diverger.

---

# 7. Contexte d'énumération

La projection porte sur le **contexte d'énumération résolu de l'invocation**.

`--runs-dir` est l'entrée de contexte existante.

Le chemin physique n'est **pas** représenté : ni `runs_dir`, ni source, ni
provenance, ni donnée de résolution du chemin par défaut.

```text
DOCUMENT MACHINE  =  volontairement non auto-descriptif
                     quant à l'emplacement physique d'énumération
```

---

# 8. Zéro

Une projection complète et aboutie ne trouvant aucune identité rend :

```json
{
  "semantic_run_discovery_contract_version": 1,
  "semantic_run_discovery_machine_representation_version": 1,
  "runs": []
}
```

avec un code de sortie `0`.

```text
runs: []   =  zéro run découvrable dans le contexte d'énumération résolu
```

Et rien de plus.

```text
ZÉRO  ≠  succès de run
      ≠  échec de run
      ≠  santé
      ≠  absence de toute activité CCR passée
      ≠  échec de projection
```

Un répertoire de runs absent est, pour l'autorité d'énumération, une
énumération aboutie à zéro identité. Il produit donc le même résultat public
qu'un répertoire présent et vide.

---

# 9. Ordre

```text
CONTRAT v1   ORDRE DU TABLEAU SÉMANTIQUEMENT NON SPÉCIFIÉ
```

La position dans `runs` n'implique ni chronologie, ni récence, ni priorité, ni
ordre de création, ni ordre alphabétique, ni ordre d'exécution. Un consommateur
apparie par `run_id`, jamais par position, et établit lui-même tout ordre dont
il a besoin à partir d'une autorité qui le porte.

---

# 10. Versions

```text
semantic_run_discovery_contract_version                 1
semantic_run_discovery_machine_representation_version   1
```

Deux axes distincts et indépendants. Ne sont pas des discriminants de
protocole, et n'apparaissent pas dans le document :

```text
version du paquet CCR
version de schéma du manifest
version de schéma du state
génération d'exécution
version d'un autre contrat
```

## 10.1 Ce que les versions gouvernent

`semantic_run_discovery_machine_representation_version` gouverne la structure :
champs admis, leur imbrication, et la frontière succès / échec de ce document.

`semantic_run_discovery_contract_version` gouverne le sens : ce qu'un
descripteur affirme, la portée de `title`, l'opacité de `run_id`, la
non-garantie d'unicité, la complétude et la sémantique du zéro.

Exigent une évolution explicite de l'axe concerné :

```text
réaffectation du rôle d'un champ
retrait d'un champ requis
renommage rompant le contrat
réinterprétation structurelle matériellement incompatible
changement du contrat de complétude, d'unicité ou de résultat vide
changement de la frontière succès / échec
```

## 10.2 Ce qui n'est pas décidé

```text
JEU DE CHAMPS DU PRODUCTEUR COURANT
  ≠  POLITIQUE DE CONSOMMATION D'UN CHAMP INCONNU FUTUR
```

Ne sont **pas** définis par le contrat v1 : champs optionnels futurs, champs
supplémentaires inconnus, compatibilité ascendante, politique de compatibilité
additive.

---

# 11. Exclusions explicites

N'apparaissent jamais dans ce document :

```text
state · control · round · statut · santé · complétion
created_at · updated_at · tout horodatage
workspace · cwd · chemin
generation · mode d'exécution
provider · moteur
session · identifiant natif
activity · invocation · issue d'invocation
metadata · compte · prose humaine de présentation
```

Aucune persistance n'est exposée comme API.

---

# 12. Références d'autorité

| Sujet | Autorité |
|---|---|
| Identité de run découvrable | [`docs/specs/run-inventory-machine.md`](run-inventory-machine.md) |
| Compatibilité des versions du paquet | [`docs/specs/compatibility.md`](compatibility.md) |
| Invariants transverses | [`docs/doctrine.md`](../doctrine.md) |

---

**Un descripteur n'est pas un état.** Ce document dit ce que CCR peut trouver
et sous quel nom ce run a été enregistré ; il ne dit rien de ce que CCR y a
fait, ni de ce qui s'y est passé.
