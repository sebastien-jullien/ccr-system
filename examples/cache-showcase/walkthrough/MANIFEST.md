# Manifeste — matériau de traversée

**Matériau de PRÉ-EXÉCUTION.** Aucun paquet de ce répertoire n'a été fourni à un
expert. Aucun run CCR n'existe. Aucun fournisseur n'a été appelé.

---

## Protocole cognitif

```text
COGNITIVE_PROTOCOL   =  PLAN B-NATIVE / HUMAN-FROZEN
```

Deux positions d'étape 1 **sollicitées séparément**, sur deux **slots CCR
distincts**, portés par deux **sessions natives distinctes**. Au moment de
l'étape 1, aucune exposition croisée n'a eu lieu par CCR : aucun transfert n'a
été émis, et aucune des deux réponses n'a été présentée à l'autre slot.

Puis fourniture formelle des mesures empiriques aux deux experts à la même
étape, puis réévaluation explicite.

```text
STAGE_2_C_PAYLOAD                   =  identique à l'octet pour les deux
                                       sessions
ÉTAT / CONTEXTE TOTAL DES SESSIONS  =  NON AFFIRMÉ IDENTIQUE
```

Ce qui est fourni formellement est identique à l'octet. Cela n'établit pas que
l'état total des deux sessions le soit : la seconde ligne ne dit pas qu'il
diffère, elle dit qu'aucune identité n'est affirmée.

Les sessions natives et leurs historiques propres sont distincts. Elles peuvent
utiliser le même moteur ou des moteurs différents. Leur contexte peut diverger
selon leur état natif et les matériaux effectivement consultés via leur CLI.

Rien de plus fort n'est avancé : CCR ne démontre ni que les contextes divergent,
ni qu'ils coïncident.

Aucune indépendance statistique ni cognitive n'est revendiquée. « Sollicitées
séparément » décrit une **séquence d'exposition**, pas une propriété des
réponses.

Conséquence de la conception native de CCR : `start` transmet **un seul prompt,
identique aux deux slots**. Le mandat de l'étape 1 est donc unique et neutre, et
il voyage dans le prompt de `start` — aucune différenciation cognitive
author/challenger n'est émise à cette étape.

---

## STAGE_1_PACKET

```text
path          examples/cache-showcase/walkthrough/stage-1-packet.md
bytes         27 753
sha256        cb45e21db5074de85b8fcf7152bfe78a12e6608eaf1f724148e2e8ac5805fb4f
```

**Fichiers sources intégrés sans modification :**

| source | octets | sha256 |
|---|--:|---|
| `mission.md` | 5 166 | `78d738f186fdba189e5781ee07829bc32207d4ff7224f49f4c703e0f07a00925` |
| `requirements.md` | 8 517 | `40b9ae652bfcde113715efe418b8d92b551fd54f6fd5f51f1efbbbe3839a782b` |
| `architecture-options.md` | 9 248 | `60d888a8d41fa8b0907b8a95602666154e6cec5923d6e2cd1130e36dcaf84f93` |

Le reste du paquet est un encadrement rédigé : avis d'étape, mandat neutre
partagé, schéma de réponse, et une section bornée de faits déterministes
— échelle du dispositif, paramètres balayés, équivalence des trois stratégies
avec l'oracle non caché, portée de la suite de qualification.

---

## STAGE_2_C_PAYLOAD

```text
path          examples/cache-showcase/walkthrough/stage-2-evidence.md
bytes         9 850
sha256        e642eaf76e961c7da8cad12d596cf1ed5d757a7beec70741ca3fa5c661c3f78b
```

**Source des mesures — unique :**

| source | octets | sha256 |
|---|--:|---|
| `observations/generated/benchmark.json` | 181 466 | `46cea7887b50f9ccd8277af60a03ec134f5627d52f961731a7160329eab0fb64` |

Toute valeur chiffrée du paquet est **dérivée par calcul** de ce rapport machine.
Aucune n'est recopiée à la main depuis un document intermédiaire.

---

## QUALIFIED_BENCHMARK_JSON

```text
path                    examples/cache-showcase/observations/generated/benchmark.json
bytes                   181 466
sha256                  46cea7887b50f9ccd8277af60a03ec134f5627d52f961731a7160329eab0fb64
rôle                    source d'audit du paquet d'étape 2
lecture par l'expert    NON REQUISE — le JSON n'est pas fourni aux experts
```

Le rapport curé `observations/qualified-benchmark.md`
(16 268 octets, `c2bda385af9369510a3a0434ee7a238a141784ae9ced3663a9322cc217cdb1a8`)
n'est pas non plus fourni aux experts : il porte une couche d'interprétation
exclue du matériau expert.

---

## Catégorie D — interprétation post-mesure

```text
D  =  EXCLUE des deux paquets destinés aux experts
```

Concrètement : la lecture causale de `qualified-benchmark.md` § 8, toute
explication du *pourquoi* des résultats observés, toute lecture préférée, toute
recommandation, tout langage de vainqueur, toute conclusion CCR.

---

## Fourniture formelle de C

```text
STAGE_1_FORMAL_C_SUPPLY   =  aucune
STAGE_2_FORMAL_C_SUPPLY   =  paquet identique à l'octet, prévu pour les deux
                             sessions, à la même étape
```

---

## Workspace

```text
WORKSPACE  =  hygiène de contexte uniquement
           ≠  frontière de sécurité du système de fichiers
```

CCR n'ajoute aucun affaiblissement de permissions aux CLI fournisseurs et ne les
confine pas. Un expert peut, dans les limites propres à sa CLI, lire d'autres
fichiers du workspace. Les deux paquets le disent explicitement et demandent que
tout recours à un autre matériau soit signalé dans la réponse.

Aucun confinement n'est affirmé ici.

---

## Ce qui n'est PAS gelé par ce manifeste

Fournisseur · arrangement des moteurs · `--max-invocations` · `workspace_cwd` ·
politique de reprise · intégration VCS · commande de lancement réelle.

Ces choix restent humains, après inspection des paquets.
