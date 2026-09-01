# Auditabilité — matériau de traversée réelle

Ce paquet documente un run CCR canonique dont le **sujet examiné est CCR
lui-même** : faut-il exposer, en lecture seule, les faits d'issue d'invocation
persistés dans `invocation-outcomes.json` ?

Contrairement à [`examples/cache-showcase/`](../cache-showcase/), ce paquet ne
contient **aucune fixture logicielle** : il n'y a ni banc d'essai, ni code de
démonstration, ni suite de qualification propre. L'objet soumis aux experts est
un artefact du produit, déjà présent dans ce dépôt. Il n'y avait donc rien à
construire pour poser la question.

Ce que ce paquet contient est donc uniquement un **compte rendu de traversée** et
ses extraits de preuve curés.

**→ [`walkthrough/`](walkthrough/)**

---

## Ce que ce paquet démontre

La traversée a été qualifiée sur un point précis, et un seul : **ce que CCR
établit depuis son état durable**, y compris lorsqu'une observation vivante
antérieure suggérait autre chose.

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

Cette page n'est pas une démonstration de contradiction entre experts. Aucune
controverse n'a été enregistrée, aucune détection n'a été lancée, aucune
décision humaine n'a été prise. Le détail de ces non-revendications figure dans
le compte rendu.
