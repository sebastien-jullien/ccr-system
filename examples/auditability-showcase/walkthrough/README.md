# Matériau de traversée — EXÉCUTÉE

**La traversée a eu lieu.** Un sujet gelé a été formellement transmis à deux
experts dans le run canonique `CCR-20260901-002`, doublé d'une annexe de quota
`CCR-20260901-001`.

```text
RUN CANONIQUE      CCR-20260901-002
ANNEXE DE QUOTA    CCR-20260901-001
RÉPONSES D'EXPERT  2
INVOCATIONS        2 sur un plafond de 6
CAPTURES D'ÉCRAN   0
```

Le compte rendu complet — ce qui a été fait, ce qui a été consigné, l'erreur
d'interprétation commise en cours de route et la façon dont l'état durable l'a
corrigée — se lit ici :

**→ [`run-CCR-20260901-002.md`](run-CCR-20260901-002.md)**

Le run brut n'est pas versionné dans ce dépôt. Le compte rendu public est un
**extrait curé**, adossé aux enregistrements réels des deux runs.

---

## À lire d'abord — la portée exacte

```text
QUESTION POSÉE   les faits d'issue d'invocation persistés dans
                 invocation-outcomes.json

CE RUN RÉEL      n'a produit naturellement ni VALID_ZERO,
                 ni fait d'issue négative durable

RUN A — M4       les deux invocations START engagées sont établies par
                 la preuve événementielle native durable

DONC             le PASS de cette traversée ne signifie pas qu'elle a
                 exercé invocation-outcomes.json
```

Le sujet soumis aux experts et le matériau produit par la traversée sont deux
choses distinctes. La confondre serait lire ce paquet à l'envers.

---

## Contenu

| Fichier | Rôle |
|---|---|
| [`run-CCR-20260901-002.md`](run-CCR-20260901-002.md) | **compte rendu rétrospectif de la traversée réelle** |
| [`MANIFEST.md`](MANIFEST.md) | manifeste d'exécution curé et note d'expurgation — provenance, empreintes, catégories retirées |
| [`transcript.md`](transcript.md) | séquence des opérations exécutées et sorties effectivement capturées, expurgées — dont les deux statuts, en cours de vol et en contexte frais |
| [`evidence-run-a.md`](evidence-run-a.md) | extraits expurgés du run canonique — gouvernance, engagements, corrélation native, quota |
| [`evidence-run-b.md`](evidence-run-b.md) | extraits expurgés de l'annexe de capacité nulle, et sa chaîne de preuve |

---

## Ce que cette traversée démontre

```text
OBSERVATION VIVANTE  ≠  AUTORITÉ D'ISSUE TERMINALE

POUR TOUT ÉNONCÉ SUR L'ÉTAT PRODUIT DE CCR

LA PLUS FORTE AUTORITÉ DURABLE VALIDE APPLICABLE
  >  observation transitoire de processus
  >  souvenir ultérieur

PREUVE DURABLE INSUFFISANTE OU INVALIDE
  →  UNKNOWN / ARRÊT
  →  JAMAIS INVENTION
```

L'enveloppe d'exécution en avant-plan de l'opérateur a rendu la main pendant le
second tour. L'opérateur en a déduit une interruption et une reprise nécessaire.
L'exécution sous-jacente s'est pourtant poursuivie, le tour s'est terminé, et
l'état durable l'a enregistré. **CCR n'a ni planté, ni été repris.**

La reconstruction, menée plus tard depuis un contexte frais après disparition du
contexte d'exécution initial, a contredit cette déduction. C'est ce qui qualifie
le point de contrôle : il n'a pas confirmé, il a réfuté.

---

## Ce que cette traversée ne fait pas

- Elle n'établit **aucun accord ni désaccord** entre les deux experts : aucune
  controverse n'a été enregistrée, et aucun acte CCR n'a comparé les positions.
- Elle ne désigne aucun vainqueur, n'attribue aucun mérite et ne confère aucun
  statut.
- Elle n'affirme **aucune décision produit** ni adoption architecturale. Les
  réponses sont du matériau argumentatif.
- Elle ne démontre **ni** `VALID_ZERO`, **ni** fait d'issue d'invocation négative
  durable : ce run n'en a produit aucun.
- Elle ne démontre **aucune projection CLI / cockpit** de
  `invocation-outcomes.json` — c'est précisément la question posée aux experts,
  pas un résultat de la traversée.
- Elle ne revendique **aucune sûreté sous concurrence**. Cette propriété reste
  rattachée à son seul historique de qualification, celui de `v0.5.0`.
- Elle ne prétend à aucun confinement du système de fichiers. Le choix d'un
  répertoire de travail est de l'hygiène de contexte, pas une frontière de
  sécurité.

---

## Branches non exécutées

```text
STEP                    NON EXÉCUTÉ
CONTROVERSE             NON ENREGISTRÉE
V3 · V4 · V5            NON EXÉCUTÉS
REPRISE                 NON UTILISÉE
RELANCE · REJEU         NON UTILISÉS
```

Leur absence est **conforme au contrat gelé**, qui ne les exigeait pas. Quatre
unités de capacité d'invocation sur six n'ont pas été utilisées.
