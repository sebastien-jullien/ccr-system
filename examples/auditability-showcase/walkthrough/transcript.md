# Transcription d'exécution — séquence et sorties retenues

**Ce que ce fichier est.** La séquence des opérations réellement exécutées
pendant la traversée, et les sorties qui en ont été **effectivement capturées**,
expurgées selon les règles du paquet.

**Ce qu'il n'est pas.** Une reconstitution. Aucune commande, aucun drapeau,
aucune ligne de sortie n'est rédigé ici de mémoire : ce qui n'a pas été capturé
est déclaré non retenu, et laissé tel quel.

Les artefacts originaux des runs restent les seules autorités. Cette page est une
projection de présentation.

---

## Séquence des opérations

| # | Opération | Sortie retenue |
|--:|---|---|
| 1 | diagnostic local (`doctor`) | oui — intégrale |
| 2 | Run B — tentative d'admission `start`, plafond 0 | oui — intégrale |
| 3 | Run B — lecture de statut | oui — extrait |
| 4 | Run A — `start`, plafond 6 | **non** — voir ci-dessous |
| 5 | Run A — lecture de statut **en cours de vol** | oui — intégrale |
| 6 | Run A — empreintes avant / après lecture | oui |
| 7 | Run A — lecture de statut **en contexte frais** | oui — intégrale |

Le lanceur employé est le script du dépôt, sous la forme
`npm run ccr --silent -- <commande>`.

---

## 1. Diagnostic local

```text
CCR — diagnostic local
Runtime
  Node.js             22.18.0
Agents (état rapporté par les CLI)
  Claude Code         2.1.224     <REDACTED_AUTH_STATE>
  Codex               0.146.0     <REDACTED_AUTH_STATE> (point d'entrée npm)
Configuration
  Chemin              ~/.ccr/config.json
  Origine             fichier
  Login proposé       true
  Codex hors Git      true (persisté)
  Effectif            true — configuration
Verrou de configuration
  Verrou              aucun
Statut : READY
```

Code de sortie `0`. Aucun appel fournisseur n'est émis par ce diagnostic : il lit
l'état rapporté par les CLI.

---

## 2. Run B — tentative d'admission à capacité nulle

```text
ccr start --title "Annexe quota — admission a capacite zero"
          --prompt  "<texte d'annexe>"
          --cwd     <REDACTED_WORKSPACE>
          --max-invocations 0
```

Sortie intégrale :

```text
Run créé : CCR-20260901-001

Initialisation incomplète : la session de « author » n'a pas pu être créée.
Erreur [CCR_INVOCATION_QUOTA_EXCEEDED] La politique du run CCR-20260901-001
autorise 0 invocation(s) ; 0 ont déjà été engagées. Aucun agent n'est sollicité.
  runId : CCR-20260901-001
  scope : run
  limit : 0
  consumed : 0
  remaining : 0

État : FAILED_INITIALIZATION. Les sessions déjà créées sont conservées.
```

Code de sortie `1`. **Une seule tentative.** Aucune relance.

La chaîne de preuve complète du zéro appel — et pourquoi le silence des journaux
n'en constitue pas la preuve — se lit dans
[`evidence-run-b.md`](evidence-run-b.md).

---

## 3. Run A — `start`

```text
ccr start --title       "Projection de lecture des faits d'issue d'invocation"
          --prompt-file <REDACTED_PROMPT_FILE>
          --cwd         <REDACTED_WORKSPACE>
          --max-invocations 6
```

```text
SORTIE DE CETTE COMMANDE   NON RETENUE
```

L'enveloppe d'exécution en avant-plan de l'opérateur a atteint son plafond de
temps de 600 000 ms et a rendu la main avant la fin de la commande. Aucune sortie
standard n'a été restituée ; seul un code de terminaison a été observé.

Ce qui s'est réellement produit ensuite n'est donc **pas** établi par cette
commande, mais par l'état durable du run — c'est le sujet de la traversée.

Le prompt transmis, lui, est intégralement publié : il est durable, et son
empreinte figure au [`MANIFEST.md`](MANIFEST.md).

---

## 4. Run A — statut en cours de vol

Capture réelle, prise après l'arrêt de l'enveloppe en avant-plan et **avant** la
fin du second tour.

```text
Run CCR-20260901-002 — Projection de lecture des faits d'issue d'invocation
  génération  NATIVE_V21_EXECUTION
  workspace   <REDACTED_WORKSPACE>
  état        WAITING_AGENT / AUTOMATION   round 0   curseur —
  opération   initialization engagée
  author     claude  session <REDACTED_SESSION_ID>  BOUND
              send : refusé (RECOVERY_REQUIRED) · handoff : refusé (RECOVERY_REQUIRED)
  challenger codex   session —                      MISSING
              send : refusé (RECOVERY_REQUIRED) · handoff : refusé (RECOVERY_REQUIRED)
  transfert   refusé (RECOVERY_REQUIRED) — source BLOCKED
  contrôle    pause : refusé (RECOVERY_REQUIRED) · resume : refusé (RECOVERY_REQUIRED)
  reprises    initialisation IN_FLIGHT_UNCERTAIN · transfert NONE · envoi NONE · handoff NONE
  gestes      initialisation : ACKNOWLEDGE_UNCERTAINTY
  alias       claude → author · codex → challenger
  quota CCR   2/6 engagée(s)   restant 4
  usage CCR   2 invocation(s) · usage fournisseur 1 observée(s) / 1 non observée(s)
  coût estimé 0 estimée(s) · 2 inconnue(s) · aucun catalogue tarifaire
```

Code de sortie `0`.

Cette sortie est **exacte et contemporaine**. Elle n'est pas une reconstitution.
Elle dit ce que CCR savait à cet instant, et notamment :

```text
usage fournisseur   1 observée(s) / 1 non observée(s)
```

CCR ne déclare pas que le second tour a échoué. Il déclare qu'il n'est **pas
observé** — ce qui est autre chose, et ce que l'opérateur a négligé.

---

## 5. Run A — la lecture ne mute pas le run

Empreintes prises de part et d'autre de la lecture de statut ci-dessus :

```text
state.json          c22a1f0bb658a6d38f53f3f004d818d02fd1eb2d6aa86d5c70fe3c6eaab2ee5b
events.jsonl        0d6489886b26d456f304665ea30cd0e8f2720c6da32d33208163595015d43826
invocations.jsonl   c6c39e2a0eff183945b19d2d08f0672aa8a7d5b59f14c4ea6aac517d38bec4fd
```

Identiques avant et après. Le rechargement calcule l'ambiguïté sans la
matérialiser : seule une commande de reprise l'inscrirait.

**Ces trois empreintes sont celles de l'état en cours de vol.** Elles ne
décrivent pas les artefacts finaux du run, qui ont légitimement changé lorsque le
second tour s'est terminé.

---

## 6. Run A — statut en contexte frais

Capture réelle, prise après la disparition du processus de `start` d'origine,
dans un contexte de reconstruction neuf.

```text
Run CCR-20260901-002 — Projection de lecture des faits d'issue d'invocation
  génération  NATIVE_V21_EXECUTION
  workspace   <REDACTED_WORKSPACE>
  état        READY / AUTOMATION   round 0   curseur author
  author     claude  session <REDACTED_SESSION_ID>  BOUND
              send : autorisé · handoff : refusé (HANDOFF_NOT_ALLOWED)
  challenger codex   session <REDACTED_SESSION_ID>  BOUND
              send : autorisé · handoff : refusé (HANDOFF_NOT_ALLOWED)
  transfert   author → challenger (source evt_000003, round 1, 10775 octets)
  contrôle    pause : autorisé · resume : sans effet (déjà satisfait)
  reprises    initialisation NONE · transfert NONE · envoi NONE · handoff NONE
  alias       claude → author · codex → challenger
  quota CCR   2/6 engagée(s)   restant 4
  usage CCR   2 invocation(s) · usage fournisseur 2 observée(s) / 0 non observée(s)
  coût estimé 0 estimée(s) · 2 inconnue(s) · aucun catalogue tarifaire
```

### La correction, dans les mots du produit

Une seule ligne sépare les deux captures, et elle porte toute la traversée :

```text
en cours de vol    usage fournisseur  1 observée(s) / 1 non observée(s)
contexte frais      usage fournisseur  2 observée(s) / 0 non observée(s)

en cours de vol    état  WAITING_AGENT   ·  opération initialization engagée
contexte frais      état  READY           ·  reprises initialisation NONE
```

Rien n'a été réparé entre les deux. Aucune reprise n'a été exécutée. Le second
tour s'est simplement terminé, et CCR l'a persisté.

---

## 7. Run B — statut

```text
Run CCR-20260901-001 — Annexe quota — admission a capacite zero
  état        FAILED_INITIALIZATION / HUMAN   round 0   curseur —
  quota CCR   0/0 engagée(s)   restant 0   ÉPUISÉ
  usage CCR   0 invocation(s) · usage fournisseur 0 observée(s) / 0 non observée(s)
  coût estimé 0 estimée(s) · 0 inconnue(s) · aucun catalogue tarifaire
```

---

## Portée de cette transcription

```text
COMMANDES PUBLIÉES     celles qui ont été émises, avec leurs valeurs locales
                       expurgées
SORTIES PUBLIÉES       celles qui ont été effectivement capturées
SORTIE DU START RUN A  NON RETENUE — déclarée comme telle, non reconstituée
```

Aucune commande de mutation n'a été exécutée sur les deux runs après leur
création : les seules opérations postérieures sont des lectures.
