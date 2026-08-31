# Matériau de traversée — EXÉCUTÉE

**La traversée a eu lieu.** Les deux paquets de ce répertoire ont été
formellement transmis à deux experts, dans le run canonique
`CCR-20260830-001`.

```text
RUN CANONIQUE      CCR-20260830-001
RÉPONSES D'EXPERT  6
INVOCATIONS        7 sur un plafond de 9
CAPTURES D'ÉCRAN   0
```

Le compte rendu complet — ce qui a été fait, ce qui a été consigné, et où CCR
s'est arrêté — se lit ici :

**→ [`run-CCR-20260830-001.md`](run-CCR-20260830-001.md)**

Le run brut n'est pas versionné dans ce dépôt. Le compte rendu public est un
**extrait curé**, adossé aux enregistrements réels du run.

---

## Contenu

| Fichier | Rôle |
|---|---|
| [`run-CCR-20260830-001.md`](run-CCR-20260830-001.md) | **compte rendu rétrospectif de la traversée réelle** |
| [`MANIFEST.md`](MANIFEST.md) | manifeste d'exécution curé — provenance, empreintes, fourniture formelle constatée |
| `stage-1-packet.md` | les octets exacts transmis dans le prompt de `start` |
| `stage-2-evidence.md` | les octets exacts transmis dans les deux `send` de l'étape 2 |
| [`contamination-markers.md`](contamination-markers.md) | aide d'inspection des réponses de l'étape 1, et le constat effectué |

---

## Protocole

Le protocole ci-dessous a été conçu avant l'exécution, puis suivi tel quel.

```text
ÉTAPE 1   matériau A + faits déterministes bornés
          mandat neutre unique, identique aux deux slots
          aucune mesure empirique fournie
          → deux positions initiales sollicitées séparément,
            sans exposition croisée CCR préalable

ÉTAPE 2   mesures empiriques qualifiées, octets identiques,
          fournies aux deux slots à la même étape
          → maintien · révision · restriction · qualification

ÉTAPE 3   contre-revue croisée native, bidirectionnelle
          → deux tours : author → challenger, puis challenger → author
```

**Pourquoi un mandat unique à l'étape 1.** `start` transmet un seul prompt,
identique aux deux slots : la conception native de CCR ne comporte aucun canal
de rôle par slot à cette étape. Le mandat d'étape 1 est donc volontairement
neutre et partagé — il ne demande à personne de défendre ni de contredire.

---

## Ce que ces paquets ne font pas

- Ils n'assignent aucune stratégie à aucun expert.
- Ils ne demandent ni accord ni désaccord.
- Ils n'affirment aucune conclusion CCR : ce que CCR a effectivement consigné à
  partir des réponses est décrit dans le compte rendu, et relève d'actes humains
  distincts de ces paquets.
- Ils ne prétendent à aucun confinement du système de fichiers. Le choix d'un
  répertoire de travail est de l'hygiène de contexte, pas une frontière de
  sécurité — et les deux paquets demandent à l'expert de signaler tout recours à
  un autre matériau du workspace.

---

## Vérifications de préparation

Contrôles de **documentation et de données** effectués avant l'exécution —
aucun test de fixture, aucune exécution de banc :

- **Étape 1** — aucune valeur empirique qualifiée, aucune interprétation causale,
  aucun compte `0/9` ni `9/9`, aucune recommandation, aucune différenciation
  cognitive entre les deux slots ; sémantique A et B préservée.
- **Étape 2** — chaque valeur chiffrée recalculée depuis le rapport machine
  qualifié et comparée au paquet ; aucune valeur de l'exécution antérieure non
  qualifiante ; aucune lecture causale ; limites et provenance présentes ;
  aucune métrique promue au-delà de ce qui a été mesuré.

Le détail des empreintes, et la fourniture formelle effectivement constatée,
figurent dans [`MANIFEST.md`](MANIFEST.md).
