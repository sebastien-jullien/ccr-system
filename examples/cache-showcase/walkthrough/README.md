# Matériau de traversée — PRÉ-EXÉCUTION

**Tous les fichiers de ce répertoire sont du matériau de pré-exécution.**

```text
FOURNISSEURS APPELÉS   0
RUNS CCR               0
CAPTURES D'ÉCRAN       0
```

Rien ici n'a été fourni à un expert. Aucune traversée n'a eu lieu. Ces fichiers
existent pour être **inspectés par une personne** avant toute décision
d'exécution.

---

## Contenu

| Fichier | Rôle |
|---|---|
| `stage-1-packet.md` | les octets exacts destinés au prompt de `start` |
| `stage-2-evidence.md` | les octets exacts destinés aux deux `send` de l'étape 2 |
| `MANIFEST.md` | provenance, empreintes, périmètre, ce qui reste à geler |
| `contamination-markers.md` | aide d'inspection des réponses de l'étape 1 |

---

## Protocole

```text
ÉTAPE 1   matériau A + faits déterministes bornés
          mandat neutre unique, identique aux deux slots
          aucune mesure empirique fournie
          → deux positions initiales sollicitées séparément,
            sans exposition croisée CCR préalable

ÉTAPE 2   mesures empiriques qualifiées, octets identiques,
          fournies aux deux slots à la même étape
          → maintien · révision · restriction · qualification
```

**Pourquoi un mandat unique à l'étape 1.** `start` transmet un seul prompt,
identique aux deux slots : la conception native de CCR ne comporte aucun canal
de rôle par slot à cette étape. Le mandat d'étape 1 est donc volontairement
neutre et partagé — il ne demande à personne de défendre ni de contredire.

---

## Ce que ces paquets ne font pas

- Ils n'assignent aucune stratégie à aucun expert.
- Ils ne demandent ni accord ni désaccord.
- Ils n'affirment aucune conclusion CCR : aucune controverse n'existe, aucun
  expert ne s'est prononcé, aucune décision humaine n'a été prise.
- Ils ne prétendent à aucun confinement du système de fichiers. Le choix d'un
  répertoire de travail est de l'hygiène de contexte, pas une frontière de
  sécurité — et les deux paquets demandent à l'expert de signaler tout recours à
  un autre matériau du workspace.

---

## Vérifications déjà effectuées

Contrôles de **documentation et de données** uniquement — aucun test de fixture,
aucune exécution de banc :

- **Étape 1** — aucune valeur empirique qualifiée, aucune interprétation causale,
  aucun compte `0/9` ni `9/9`, aucune recommandation, aucune différenciation
  cognitive entre les deux slots ; sémantique A et B préservée.
- **Étape 2** — chaque valeur chiffrée recalculée depuis le rapport machine
  qualifié et comparée au paquet ; aucune valeur de l'exécution antérieure non
  qualifiante ; aucune lecture causale ; limites et provenance présentes ;
  aucune métrique promue au-delà de ce qui a été mesuré.

Le détail des empreintes figure dans `MANIFEST.md`.

---

## Ce qui reste à décider

Fournisseur · arrangement des moteurs · `--max-invocations` · `workspace_cwd` ·
politique de reprise · intégration VCS · commande de lancement réelle · condition
d'arrêt.

Aucun de ces choix n'est fait ici.
