# CCR — Spécification · Intention de production d'un run

```text
STATUT                              contrat courant
PORTÉE                              déclaration procédurale humaine · run natif
CONTRAT SÉMANTIQUE                  intention de production
```

Ce document définit ce que CCR enregistre lorsqu'une autorité humaine déclare
qu'aucun pas de production natif supplémentaire n'est présentement prévu pour un
run, et ce qu'une telle déclaration ne signifie pas.

---

# 1. Autorité et portée

## 1.1 Ce que ce document possède

```text
LA DÉCLARATION PROCÉDURALE D'INTENTION DE PRODUCTION D'UN RUN NATIF,
  sa création, son idempotence, sa réversibilité,
  et son effet sur l'admission d'un pas natif
```

Et rien d'autre.

## 1.2 Qui décide, qui enregistre

```text
AUTORITÉ SÉMANTIQUE   l'autorité de contrôle humaine
CCR                   enregistreur technique
```

```text
ROLE       ≠  AUTORITÉ DE FIN DE PRODUCTION
PROVIDER   ≠  ROLE
```

Ni `author`, ni `challenger`, ni `AUTOMATION` ne créent ce fait. Un expert peut
écrire qu'il estime le travail terminé : ce texte est une position, jamais une
déclaration d'intention de production.

## 1.3 Génération

```text
PROTOCOLE NATIF   seul concerné
```

Un run historique n'a ni ExpertSlot, ni autorité de contrôle native à qui
rattacher la déclaration. Les deux commandes le refusent explicitement, sans
rien convertir.

---

# 2. Le fait

```text
production_intent = NO_STEPS_INTENDED

  = l'autorité de contrôle humaine a délibérément déclaré qu'aucun pas de
    production natif supplémentaire n'est PRÉSENTEMENT prévu pour ce run
```

```text
production_intent = STEPS_INTENDED

  = P3 lui-même n'interdit pas de pas de production natif supplémentaire
```

Le fait est :

```text
procédural
durable
append-only
réversible
sans jugement
```

## 2.1 Ce que le fait ne signifie jamais

```text
NO_STEPS_INTENDED   ≠ correction du logiciel
                    ≠ complétude d'un candidat
                    ≠ vainqueur désigné
                    ≠ accord de l'author
                    ≠ accord du challenger
                    ≠ accord des experts
                    ≠ convergence
                    ≠ controverse résolue
                    ≠ travail épuisé
                    ≠ absence de source transférable
                    ≠ run terminé
                    ≠ CLOSED
```

`CONVERGED` reste absent de la machine d'état, et ce contrat ne le réintroduit
pas : la mesure de convergence n'appartient toujours pas à cette version, et
aucun état positif canonique de désaccord persistant n'est créé.

## 2.2 Asymétrie

```text
NO_STEPS_INTENDED   →   P3 refuse l'admission d'un pas natif

STEPS_INTENDED      ≠   pas actuellement admissible
```

`STEPS_INTENDED` est une **non-interdiction**, jamais une autorisation. Les
autres autorités continuent de décider pour leur compte, et P3 n'en
court-circuite aucune :

```text
quota CCR par run
RunState
propriétaire du contrôle
conditions de transfert
conditions de fournisseur et d'infrastructure
autres gardes d'admission natives
```

---

# 3. Surface publique

```text
ccr end-production --note <texte> [--acknowledge-downgrade <run_id>]
                   [--run <run_id>] [--runs-dir <répertoire>]

ccr reactivate-production [--note <texte>]
                          [--run <run_id>] [--runs-dir <répertoire>]
```

Les règles de résolution du run sont celles des autres commandes de contrôle,
inchangées.

## 3.1 Aucun autre nom

```text
stop · finish · close · reopen-production · converged
  =  NE SONT PAS DES ALIAS DE CES COMMANDES
```

`reactivate` plutôt que `reopen` : *rouvrir* suggérerait qu'un run avait été
**fermé**, ce qui est précisément ce que ce contrat n'affirme pas.

## 3.2 Codes de sortie

```text
0   la déclaration a été enregistrée, ou était déjà satisfaite
1   erreur CCR
2   usage incorrect, y compris l'acquittement de descente manquant ou erroné
```

---

# 4. Notes

```text
end-production          --note   OBLIGATOIRE
reactivate-production   --note   FACULTATIVE
```

Lorsqu'un fait est effectivement écrit, la note applicable est :

```text
texte humain d'audit et de contexte
conservée durablement
conservée verbatim
opaque au raisonnement sémantique de CCR
```

## 4.1 Ce qu'une note n'est pas

```text
NOTE   ≠ preuve d'autorité
       ≠ preuve de correction
       ≠ preuve d'accord
       ≠ preuve de convergence
       ≠ acquittement de descente
```

L'autorité est l'acte de contrôle humain lui-même, jamais son texte.
L'acquittement de descente est un drapeau distinct et nommé.

## 4.2 Idempotence et note

Une opération sans effet **n'écrit pas** de fait pour loger une note.

```text
NOOP + note   →   aucun événement durable
```

Fabriquer un fait pour persister un texte transformerait une absence de
changement en histoire.

---

# 5. Idempotence

État logique initial, en l'absence de tout fait applicable :

```text
STEPS_INTENDED
```

```text
END effectif           STEPS_INTENDED     →  NO_STEPS_INTENDED
                       exactement un fait durable de fin

END déjà satisfait     NO_STEPS_INTENDED  →  NOOP
                       aucun fait supplémentaire

REACTIVATION effective NO_STEPS_INTENDED  →  STEPS_INTENDED
                       exactement un fait durable de réactivation

REACTIVATION déjà      STEPS_INTENDED     →  NOOP
satisfaite             y compris sans aucun fait historique
                       aucun fait supplémentaire
```

```text
NOOP   ≠  ERREUR
NOOP   →  aucun historique fabriqué
```

## 5.1 L'histoire reste entière

Une réactivation ne supprime ni ne réécrit le fait de fin qui la précède. Le
journal est append-only, et l'intention courante se dérive de son **dernier**
fait applicable, dans l'ordre durable du journal.

---

# 6. Effet sur l'admission d'un pas natif

```text
production_intent = NO_STEPS_INTENDED
  →  un nouveau pas natif est REFUSÉ
  →  refus constaté AVANT toute invocation fournisseur
```

Garanties du refus :

```text
invocation fournisseur          0
invocation créée                0
quota consommé                  0
source transférable consommée   0
fait durable écrit              0
RunState modifié                0
propriétaire du contrôle modifié 0
```

## 6.1 Ce que la garde n'affirme pas

```text
correct · complet · convergé
  =  AUCUN NOUVEAU JUGEMENT
```

Le refus rapporte une déclaration humaine, et rien d'autre.

---

# 7. Transfert en attente

```text
END   →  consommer · supplanter · résoudre · mettre en quarantaine   =   AUCUN
```

Le transfert et l'intention de production sont deux faits distincts. Après une
fin de production, un run peut donc simultanément porter :

```text
production_intent               NO_STEPS_INTENDED
source transférable en attente  OUI
```

sans contradiction. Aucun des deux ne dit quoi que ce soit de l'autre.

---

# 8. Quota

```text
max_invocations         ≠  autorité P3
épuisement du quota     ≠  production_ended
production_ended        ≠  épuisement du quota
```

Ni `end-production` ni `reactivate-production` ne modifient le nombre
d'invocations consommées, la limite du run, ou l'état de sa politique de quota.

---

# 9. RunState

```text
P3  →  RunState   =   AUCUN
```

```text
production_ended         ne produit ni PAUSED, ni CLOSED, ni CONVERGED
production_reactivated   ne rend pas le run à l'automatisation
```

Aucun nouvel état de run n'est introduit, et `CLOSED` n'est pas réutilisé pour
signifier autre chose que ce qu'il signifie.

## 9.1 Distinction avec `pause` / `resume`

```text
pause · resume            changent l'état et le propriétaire du contrôle
end · reactivate          ne changent ni l'un ni l'autre
```

Un run peut être `READY / AUTOMATION` et porter `NO_STEPS_INTENDED` ; un run
peut être `PAUSED / HUMAN` et porter `STEPS_INTENDED`. Les deux dimensions sont
indépendantes.

---

# 10. Acquittement de descente

```text
--acknowledge-downgrade <run_id>
```

```text
PORTÉE   ccr end-production, et elle seule
```

L'option n'existe pas sur `ccr reactivate-production`, et son absence y est un
fait de conception, non un oubli : une réactivation n'est effective que si
l'intention courante vaut déjà `NO_STEPS_INTENDED`, ce qui exige un
`production_ended` antérieur. Elle ne peut donc jamais être le premier fait P3
d'un run, ne franchit jamais la frontière, et n'aurait rien à faire acquitter.
L'y accepter promettrait un acquittement sans objet.

```text
reactivate-production --acknowledge-downgrade …
  →  option inconnue
  →  code de sortie 2
  →  fait P3 écrit   0
```

Les règles qui suivent portent donc toutes sur `end-production`.

## 10.1 La frontière

```text
FRONTIÈRE   =   PREMIER FAIT D'INTENTION DURABLE DE CE RUN
```

À partir de ce fait, le journal du run n'est plus lisible par une version
antérieure de CCR : celle-ci refuse un type de fait durable inconnu, franchement
et sans le sauter.

## 10.2 Exigence

```text
aucun fait P3 dans ce run  +  le geste en écrirait un
  →  ACQUITTEMENT REQUIS

acquittement absent
  →  commande refusée
  →  code de sortie 2
  →  fait P3 écrit             0
  →  mutation du journal       0
  →  mutation du RunState      0
```

La sortie explique la frontière et permet de reformer l'invocation.

```text
PRÉSENCE de la divulgation de descente   NORMATIVE
CONTENU de la divulgation                NORMATIF
FORMULATION LITTÉRALE                    NON NORMATIVE
```

## 10.3 Validation de la valeur

```text
--acknowledge-downgrade PRÉSENT
  →  sa valeur DOIT TOUJOURS être exactement le run_id résolu
```

Cette règle vaut :

```text
avant le premier fait P3
après le premier fait P3
sur une reprise idempotente
```

Une valeur qui ne désigne pas ce run n'est **jamais** ignorée au motif que la
frontière serait déjà franchie.

```text
valeur ≠ run_id résolu
  →  code de sortie 2
  →  fait P3 écrit   0
```

## 10.4 Après la frontière

```text
le run porte déjà au moins un fait P3
  →  frontière DÉJÀ FRANCHIE
  →  acquittement NON REQUIS

acquittement fourni malgré tout, avec le bon run_id
  →  accepté
  →  aucune autorité supplémentaire
  →  aucune écriture supplémentaire de son propre fait
```

Cela préserve les reprises après une réponse perdue.

---

# 11. Projection publique

L'intention de production est publiée par le contrat d'activité durable machine,
et par lui seul :

```text
ccr run-activity <run_id> --format json --machine-representation-version 2
  →  production_intent, sous AVAILABLE uniquement
```

```text
ACTIVITÉ   ≠   FAIT DE CYCLE DE VIE OU D'INTENTION
```

Aucun fait P3 ne devient un `activity_kind`. Le vocabulaire fermé des genres
d'activité de F2 v1 n'est pas élargi.

Autorité :
[`docs/specs/run-activity-machine.md`](run-activity-machine.md).

---

# 12. Compatibilité

Deux dimensions **distinctes**, qui ne se déduisent pas l'une de l'autre.

```text
COMPATIBILITÉ DE SYNTAXE D'INVOCATION   ≠   COMPATIBILITÉ DE DONNÉES DU JOURNAL
```

## 12.1 Syntaxe d'invocation et représentation demandée

| Invocation | Binaire | Résultat |
|---|---|---|
| `run-activity <id> --format json` | nouveau | représentation 1, forme exacte |
| `… --machine-representation-version 1` | nouveau | représentation 1, forme exacte |
| `… --machine-representation-version 2` | nouveau | représentation 2 |
| `… --machine-representation-version <n>` non supportée | nouveau | sortie 2, aucun document |
| `… --machine-representation-version 2` | v1.1.0 | option inconnue, sortie 2, aucun document |

Le dernier cas n'est pas une promesse de conception : le parseur de v1.1.0
refuse tout drapeau qu'il ne connaît pas. Il n'existe donc **aucune descente
silencieuse** — un binaire antérieur ne rend jamais discrètement la
représentation 1 à un consommateur qui en demandait 2.

## 12.2 Données du journal

Le validateur de journal d'un binaire antérieur refuse tout type de fait durable
qu'il ne connaît pas. Ce refus est **constant** ; ce qui varie est l'enveloppe
que chaque commande lui donne, et cette enveloppe est celle du contrat que la
commande possédait déjà.

| Commande du binaire antérieur | Journal portant un fait P3 |
|---|---|
| lecture directe du journal (`status`, …) | échec dur, `JOURNAL_INVALID`, code de sortie 1 |
| `run-activity --format json` | `PROJECTION_FAILURE`, code de sortie 0 |
| commandes ne relisant pas ce journal (`list`, `run-descriptors`, `invocation-outcomes`) | inchangées |

```text
JAMAIS SAUTÉ EN SILENCE
```

C'est la propriété qui compte, et elle tient dans les trois cas. `PROJECTION_FAILURE`
n'est pas une omission : c'est le statut par lequel le contrat F2 de la version
antérieure déclare **lui-même** qu'une matière est inexploitable. Le binaire
antérieur ne rend alors aucune activité, aucune histoire partielle, et aucun
champ deviné — il ne prétend à rien.

```text
journal sans fait P3   +   binaire antérieur   →  lisible, inchangé
journal antérieur      +   nouveau binaire     →  lisible, inchangé
```

```text
MIGRATION DE DONNÉES   =   AUCUNE
```

Aucun fait ancien n'est modifié pour obtenir une compatibilité descendante
artificielle.

---

# 13. Relations d'autorité

| Sujet | Autorité |
|---|---|
| Activité durable machine et `production_intent` | [`run-activity-machine.md`](run-activity-machine.md) |
| Descripteur sémantique de run | [`run-descriptors-machine.md`](run-descriptors-machine.md) |
| Faits d'issue d'invocation | [`invocation-outcome.md`](invocation-outcome.md) |
| Compatibilité des versions du paquet | [`compatibility.md`](compatibility.md) |
| Invariants transverses | [`../doctrine.md`](../doctrine.md) |

---

**Une intention n'est pas un verdict.** Ce document dit ce qu'une autorité
humaine a déclaré vouloir faire de la suite d'un run ; il ne dit rien de ce qui a
été soutenu, contesté, prouvé ou décidé.
