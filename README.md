# CCR — Contre-expertise croisée

**Contradictory Cross-Review.** Plusieurs experts IA, chacun dans sa propre conversation persistante, confrontés par un orchestrateur qui ne tranche jamais à votre place.

> Les conversations natives assurent la continuité cognitive.
> CCR assure la continuité épistémique.
> **La preuve l'emporte sur l'accord.**

---

## Pourquoi CCR

Sur un projet devenu vaste et transversal, un agent IA peut construire une représentation incorrecte du système, puis rester parfaitement cohérent avec cette représentation pendant l'analyse, la spécification, la planification, l'implémentation, les tests — et jusqu'à l'audit de son propre travail.

Le risque n'est plus l'hallucination ponctuelle, facile à repérer. C'est l'**erreur auto-cohérente** : assez plausible et assez bien documentée pour traverser plusieurs étages du travail sans jamais déclencher d'alarme.

CCR introduit une rupture cognitive contrôlée :

```text
un expert propose
      ↓
un second expert cherche à le réfuter
      ↓
les désaccords empiriques reviennent à la preuve
      ↓
les désaccords interprétatifs reviennent à l'explicitation du cadre
      ↓
les désaccords normatifs reviennent à l'humain
```

Deux modèles qui disent la même chose n'ont rien démontré. CCR ne transforme jamais une concordance en vérité.

---

## Ce qu'est CCR aujourd'hui

Un outil local, livré et utilisable. Il tient deux rôles d'expertise — **Auteur** et **Challenger** — dans des sessions natives persistantes distinctes, conserve à l'extérieur de ces conversations un état canonique auditable, et vous laisse intervenir à tout moment.

Ce qu'il sait faire :

- ouvrir et maintenir des sessions natives persistantes, une par rôle ;
- transmettre la réponse d'un expert à l'autre, verbatim, par passage de témoin ;
- accepter vos messages, vos suspensions et vos reprises à tout instant ;
- ouvrir une session interactive native pour que vous parliez directement à un expert ;
- représenter une controverse : un désaccord structuré, ancré dans les échanges qui l'ont produit ;
- retenir des matériaux au dossier, et enregistrer qu'on les a versés au débat ;
- produire, sur demande explicite, une proposition de réconciliation non contraignante ;
- enregistrer votre réponse à une proposition, et vos actes de réconciliation ;
- compter ce qu'il déclenche, et refuser de dépasser la limite que vous avez posée ;
- persister l'historique, et reprendre après une interruption sans rien inventer.

Ce qu'il ne fait pas — et c'est délibéré :

```text
aucun juge modèle          aucun gagnant désigné
aucun classement           aucune recommandation
aucune clôture automatique aucun consensus tenu pour vrai
```

`CONVERGED` reste un état **réservé** : aucune version ne l'assignera avant qu'on ait défini ce qu'une convergence démontrerait.

---

## Principes essentiels

Une sélection ; la doctrine complète est dans [`docs/doctrine.md`](docs/doctrine.md).

| | |
|---|---|
| **Rôle ≠ fournisseur** | Auteur et Challenger sont des rôles du protocole. Le moteur qui les exécute est une affectation technique. |
| **Continuité cognitive ≠ continuité épistémique** | La session native porte le raisonnement ; l'état CCR porte la provenance. Aucune ne remplace l'autre. |
| **Constat ≠ remède** | « Ceci est mauvais » n'implique pas « voici ce qu'il faut faire ». Le passage de l'un à l'autre est une décision. |
| **Retenir ≠ verser au débat** | Enregistrer un élément n'engage aucune position ; l'opposer à une cible en engage une. |
| **Validation de forme ≠ validation de fond** | Une forme correcte n'établit ni pertinence, ni fiabilité, ni suffisance, ni vérité. |
| **Proposition ≠ décision** | Une proposition produite par CCR n'a aucun effet par elle-même. |
| **Réponse ≠ effet autoritaire** | Répondre à une proposition est un acte humain enregistré ; accepter n'est pas faire sien. |
| **Clôture ≠ vérité ≠ convergence ≠ accord des experts** | Une clôture est un effet humain explicite, borné à son périmètre. |
| **Inconnu ≠ zéro** | Ne pas avoir observé n'est pas avoir observé zéro. |
| **Présentation ≠ autorité métier** | Une interface reformule et hiérarchise ; elle n'invente aucun état. |

Le modèle d'autorité se lit ainsi : l'**autorité normative** est humaine et finale ; l'**autorité factuelle** appartient à la preuve et au code sur ce qui est démontrable ; les **experts** ont une autorité argumentative ; CCR n'a qu'une autorité **procédurale** — orchestrer, conserver, structurer, exposer, gouverner.

---

## Fonctionnement d'un run

```text
créer un run
      ↓
affecter un moteur à chaque rôle
      ↓
établir les sessions natives
      ↓
échanges et passages de témoin
      ↓
interventions humaines quand elles sont utiles
      ↓
historique · reprise · poursuite
```

Ce n'est **pas** un pipeline obligatoire. Un run peut vivre entièrement de ses échanges et de vos interventions.

Trois capacités s'ajoutent lorsqu'elles sont justifiées, et seulement alors :

- **une controverse**, quand un désaccord mérite d'être porté explicitement ;
- **des matériaux et des adductions**, quand un élément mérite d'être versé au débat ;
- **une réconciliation**, quand vous voulez enregistrer ce que vous décidez d'un désaccord — avec ou sans proposition préalable de CCR.

Aucune de ces trois n'est requise, aucune n'est déclenchée automatiquement, et une proposition ne décide jamais rien.

---

## Cockpit local

Le cockpit est l'interface principale. Il écoute uniquement sur `127.0.0.1`.

```bash
npm run ccr -- cockpit
```

Par défaut sur `http://127.0.0.1:4317/` ; `--port` change le port. Un seul cockpit par jeu de données : un second démarrage échoue avant d'ouvrir le moindre port. `Ctrl-C` libère le verrou.

Quatre vues :

| Vue | Ce qu'on y fait |
|---|---|
| **Discussion** | lire les échanges, voir la prochaine action, écrire à un expert, suspendre ou reprendre, consulter la consommation |
| **Dossier** | controverses, matériaux, adductions, réconciliation |
| **Historique** | le journal du run en lecture humaine, les événements techniques repliés et révélables |
| **État & reprise** | l'état opérationnel, et ce qu'il faut pour reprendre |

C'est aussi depuis le Dossier que s'enregistre une controverse : la ligne de commande ne porte pas ce geste.

---

## CLI

La ligne de commande couvre le pilotage du run et de nombreuses opérations avancées.

```bash
npm run ccr -- <commande>     # depuis le dépôt
ccr <commande>                # si le paquet est lié
```

**Conduire un run**

```bash
ccr start --title "Politique de rétention des fichiers RAW" --prompt-file mission.md
ccr list
ccr status
ccr step                      # un seul passage de témoin
ccr send challenger "Précisez le point 2"
ccr pause                     # puis : ccr handoff author
ccr resume
```

`ccr start` accepte `--author-provider` et `--challenger-provider`, ainsi que `--max-invocations` pour poser une limite stricte du nombre d'invocations CCR durablement engagées sur ce run — à la création, et définitivement. Ce sont les engagements durables qui sont comptés, jamais les appels fournisseurs observés.

**Dossier et débat**

```bash
ccr material text "Le cache expire en 30 s" --label "mesure terrain"
ccr adduce mat_000001 --target ctve_000002 --orientation objects-to
ccr detect challenger --controversy ctv_000001
```

`ccr material` retient ; `ccr adduce` verse au débat. Ce sont deux actes distincts, et l'orientation n'a pas de valeur par défaut.

**Réconciliation**

```bash
ccr reconciliation                        # lecture ; n'écrit rien
ccr propose --target ctv_000001 --scope-kind WHOLE --expert author
ccr respond --target ctv_000001 --proposal rcn_000001 --mode ACCEPT --provenance ...
ccr reconcile --target ctv_000001 --scope-kind WHOLE --content "..." --provenance ...
```

Chaque effet d'un acte de réconciliation est déclaré par son propre drapeau : exécuter la commande ne clôt rien, ne retire rien et ne supersède rien tant que vous ne l'avez pas demandé.

**Diagnostic et reprise**

```bash
ccr doctor                    # runtime, CLI fournisseurs, authentification, configuration
ccr setup                     # configuration du poste, interactive
ccr recover                   # sans action : affiche les gestes de reprise permis
ccr invocation-outcomes       # lecture ; n'écrit rien
```

`ccr recover` ne choisit jamais un geste à votre place, même lorsqu'un seul est disponible.

`ccr invocation-outcomes [<run_id>] [--invocation <invocation_id>]` projette les faits d'issue d'invocation déjà persistés, dans leur ordre d'ajout. La projection est **centrée sur le fait** : elle énumère les enregistrements qui existent, jamais les invocations qui pourraient en porter un, et n'interroge aucune autre autorité — ni registre d'engagement, ni transcript natif, ni usage, ni objet de domaine.

Une requête sans correspondance annonce qu'aucun fait dédié n'est enregistré. Ce n'est ni un succès, ni un échec, ni `VALID_ZERO`, ni une invocation inconnue, et cela n'affirme rien de ce que les autres autorités établissent. `VALID_ZERO`, lorsqu'il est enregistré, est rendu sous son code exact, accompagné de sa seule glose de cardinalité. **Aucune autorité générique de succès n'existe** : un succès qui produit son objet de domaine reste attesté par cet objet.

Les genres d'issue, les motifs et la sémantique exacte de ce que la commande rend sont définis par [`docs/specs/invocation-outcome.md`](docs/specs/invocation-outcome.md).

Codes de sortie : `0` succès · `1` erreur CCR · `2` usage incorrect. `ccr` sans argument affiche l'aide complète.

---

## Installation et démarrage

**Prérequis**

- Node.js `>= 22.18.0` — le code TypeScript est exécuté nativement, sans étape de build ;
- les CLI officielles des fournisseurs que vous comptez utiliser, installées et authentifiées.

**Installation**

```bash
npm install
```

**Vérifier le poste**

```bash
npm run ccr -- doctor
```

**Premier run**

```bash
npm run ccr -- start --title "Mon sujet" --prompt-file mission.md
npm run ccr -- cockpit
```

**Configuration**

Les préférences locales vivent dans `~/.ccr/config.json`, écrites par `ccr setup`. Quelques variables d'environnement ajustent l'exécution, dont `CCR_RUNS_DIR` pour déplacer le répertoire des runs.

---

## Experts et fournisseurs

```text
rôle d'expert    author | challenger    identité du protocole
fournisseur      le moteur qui l'exécute    affectation technique
```

Les moteurs actuellement implémentés sont **Claude Code** et **Codex**. Ce sont des fournisseurs, pas des rôles : rien n'associe un moteur donné à l'Auteur ou au Challenger. Par défaut `ccr start` affecte Claude à l'Auteur et Codex au Challenger — une simple convention de liaison, que les deux options de la commande vous laissent remplacer entièrement.

Les deux rôles peuvent partager le même moteur — à une condition absolue : **les sessions natives restent distinctes**. Une conversation unique pour deux rôles produirait une indépendance fictive.

Une affectation ne change pas pendant la vie d'un rôle dans un run. Déplacer un rôle d'un moteur à l'autre n'est pas une reprise, c'est une rupture de continuité cognitive.

---

## État canonique, persistance et reprise

CCR conserve à l'extérieur des conversations : l'identité du run, les identités de session natives, l'état opérationnel, le journal des événements, et les journaux dédiés de la controverse, des matériaux et de la réconciliation.

Par défaut, ces données vivent sous `.ccr/runs/` à la racine du projet ; `--runs-dir` ou `CCR_RUNS_DIR` les déplacent.

Un arrêt brutal ne détruit ni l'identité du run, ni les sessions, ni les faits déjà écrits, ni la capacité de reprendre. Une opération engagée dont l'issue est inconnue **reste inconnue** : CCR ne la convertit ni en succès, ni en échec, et ne rejoue rien de lui-même.

Un run n'a qu'un seul écrivain à la fois. Un verrou périmé se lève explicitement, jamais par contournement silencieux.

Les faits historiques ne sont pas réécrits. Une confirmation, une contestation ou une correction ultérieure est un **fait nouveau** qui référence le précédent.

---

## Gouvernance d'usage

Trois grandeurs distinctes, jamais fusionnées :

```text
Invocation         ce que CCR a durablement engagé  comptable exactement
UsageObservation   ce qui a été observé             provenance obligatoire
CostEstimate       ce qui s'en dérive               estimation versionnée
```

Une invocation CCR n'est ni un appel externe confirmé, ni un événement de facturation. Un montant rapporté par un fournisseur est une grandeur distincte d'une estimation CCR, et ne vient jamais silencieusement combler son absence.

Le quota CCR se pose à la naissance d'un run et n'est plus modifiable. Il n'est pas un quota fournisseur : CCR n'invente aucune limite externe. **CCR ne peut jamais relever implicitement son propre plafond.**

Quand une consommation ne peut pas être établie, l'écran le dit. Une absence de mesure ne devient jamais un zéro.

---

## Controverses, matériaux et adductions

Une **controverse** est un désaccord structuré : enregistré par vous, ancré dans les échanges dont il provient. La structurer ne la rend ni vraie, ni résolue, ni close.

Un **matériau** est un élément que vous retenez au dossier : un événement du run, un texte, une référence externe conservée telle quelle. CCR ne résout pas les références externes et n'en observe pas le contenu.

Une **adduction** verse un matériau déjà retenu dans une controverse déjà enregistrée, avec une orientation déclarée.

```text
soutien                      ≠  établit que c'est vrai
objection                    ≠  établit que c'est faux
aucune orientation déclarée  ≠  sans pertinence
```

Deux actes contraires portant sur le même élément et la même cible sont deux faits. Aucun n'efface l'autre, aucun n'est préféré, et rien n'est compté pour trancher.

Ni le silence, ni l'inactivité, ni un retrait de position, ni un accord inféré ne clôturent une controverse.

---

## Réconciliation

CCR sait lire l'état d'un désaccord, produire une proposition, enregistrer votre réponse, enregistrer votre acte, et dériver quelques signaux structurels. Il ne décide rien.

**Une proposition** est attribuée à CCR et n'a aucun effet par elle-même. Ses options ne sont ni classées, ni notées, ni recommandées ; une proposition à une seule option ne contraint pas davantage.

**Une réponse** — accepter ou rejeter — est un acte humain enregistré, et rien de plus. Elle ne clôt rien, ne retire rien, ne supersède rien.

```text
accepter  ≠  faire sien
```

**Un acte de réconciliation** porte votre propre contenu, votre cible, votre périmètre explicite, votre provenance déclarée, et les effets que vous déclarez. C'est le seul objet de ce flux qui puisse porter un effet autoritaire de réconciliation.

Une **clôture** est un effet humain explicite, borné aux unités que vous énumérez.

```text
clôture  ≠  vérité  ≠  convergence  ≠  accord des experts
```

Aucune clôture n'est automatique. Superséder une décision ne retire pas un effet de clôture : une réouverture se déclare explicitement. Ni la récence, ni la contradiction ne supersèdent quoi que ce soit.

CCR rend visibles des signaux de désaccord observables, mais ne tient aucun état « en désaccord » : une absence de clôture n'est pas un désaccord persistant, et une absence de signal n'est pas un accord.

**Proposition assistée par modèle.** Elle ne part que sur demande explicite. Le modèle reçoit un contexte canonique, borné et auditable, restreint au périmètre soumis, dans une session fraîche — jamais la session native d'un expert : ce qu'un modèle « se rappelle » n'est ni énumérable, ni vérifiable, alors que ce que CCR transmet l'est.

```text
donner à lire  ≠  donner autorité
contexte       ≠  mandat
```

Cette politique de session fraîche vaut pour la proposition de réconciliation, et pour elle seule.

---

## Sécurité et frontières de confiance

CCR est un outil **local**. Le cockpit écoute sur `127.0.0.1` et n'est pas conçu pour être exposé.

L'authentification passe par les CLI officielles des fournisseurs. CCR n'extrait aucun jeton, ne lit aucun magasin de secrets, n'en persiste aucun, et n'affaiblit jamais les protections que ces outils appliquent.

Le contenu produit par un modèle est traité comme non fiable : il est analysé, converti, puis construit nœud par nœud — jamais concaténé comme du balisage. Le balisage brut est rendu en texte, aucune ressource externe n'est chargée, et un lien reçu d'un tiers reste du texte tant qu'aucune analyse ne l'a autorisé.

**Une limite à connaître.** Le workspace est le répertoire de travail associé au run : c'est le contexte depuis lequel les experts sont lancés. Ce n'est **pas** une frontière de sécurité. CCR ne surveille pas et ne restreint pas ce que les CLI fournisseurs lisent sur le disque. Aucun confinement, aucun bac à sable, aucune isolation du système de fichiers n'est promis.

---

## Documentation

| Où | Quoi |
|---|---|
| [`docs/doctrine.md`](docs/doctrine.md) | **doctrine normative** — ce que CCR affirme, et ce qu'il refuse d'affirmer |
| [`docs/specs/controversy.md`](docs/specs/controversy.md) | contrat courant de la controverse |
| [`docs/specs/evidence.md`](docs/specs/evidence.md) | contrat courant des matériaux et adductions |
| [`docs/specs/reconciliation.md`](docs/specs/reconciliation.md) | contrat courant de la réconciliation |
| [`docs/specs/invocation-outcome.md`](docs/specs/invocation-outcome.md) | contrat courant de la projection des issues d'invocation |
| [`docs/design-foundations.md`](docs/design-foundations.md) | les principes de conception dont CCR part |
| [`docs/design-history.md`](docs/design-history.md) | histoire intellectuelle rétrospective de CCR |
| [`examples/cache-showcase/walkthrough/run-CCR-20260830-001.md`](examples/cache-showcase/walkthrough/run-CCR-20260830-001.md) | traversée réelle de bout en bout — compte rendu curé d'un run canonique sur la fixture de conception de cache |
| [`examples/auditability-showcase/walkthrough/run-CCR-20260901-002.md`](examples/auditability-showcase/walkthrough/run-CCR-20260901-002.md) | traversée réelle d'auditabilité — compte rendu curé d'un run canonique où l'état durable a corrigé une interprétation vivante prématurée |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | comment contribuer |
| [`SECURITY.md`](SECURITY.md) | signalement de vulnérabilité et frontières de confiance |
| [`AGENTS.md`](AGENTS.md) · [`CLAUDE.md`](CLAUDE.md) | instructions de projet pour le travail assisté par IA |

Le présent README est un point d'entrée : il explique et oriente. Pour toute
question normative, `docs/doctrine.md` fait foi ; pour un contrat technique, la
spécification du domaine concerné.

---

## Contribuer

Les signalements et les propositions de changement sont bienvenus. Trois attentes
tiennent lieu de règle :

- **un changement, un objet** ;
- **aucun changement sémantique silencieux** — si votre modification change ce que
  CCR affirme ou enregistre, dites-le explicitement ;
- **les contrats publics se documentent** — une surface décrite dans `docs/` change
  dans la même proposition que le code.

Le projet exige un **sign-off DCO** sur chaque commit. Il n'y a pas de CLA, et
aucune cession de droits n'est demandée : vous conservez la paternité de votre
travail, apporté sous licence MPL-2.0.

Le détail est dans [`CONTRIBUTING.md`](CONTRIBUTING.md).

---

## Développement

```bash
npm install
npm run typecheck        # tsc --noEmit
npm test                 # tests unitaires
```

`npm test` n'appelle aucun fournisseur : il s'exécute hors ligne, sur des doubles
contrôlés et des répertoires temporaires.

Deux campagnes plus lourdes existent — `npm run test:integration` et
`npm run test:performance` — avec des délais étendus ; l'intégration exerce les
CLI fournisseurs réelles lorsque le poste le permet.

> **Attention :** `npm run test:integration` peut solliciter des fournisseurs
> authentifiés et consommer de la ressource. Ne lancez cette campagne que
> volontairement, dans un environnement prévu à cet effet.

Structure du dépôt :

```text
bin/               point d'entrée exécutable
src/               adapters · cli · cockpit · config · core · lock
                   process · runtime · services · store
docs/              doctrine, spécifications courantes et documents de conception
tests/             unit · integration · performance · fixtures · helpers
```

---

## Licence

**MPL-2.0** — voir [`LICENSE`](LICENSE).

CCR a été créé par Sébastien JULLIEN. Voir [`AUTHORS.md`](AUTHORS.md).

---

## Philosophie

CCR n'est pas conçu pour remplacer le jugement humain. Il vise à rendre explicite
la frontière entre :

- ce que le code permet d'établir ;
- ce qu'un modèle infère ;
- ce qu'un second modèle conteste ;
- ce que les preuves démontrent ;
- et ce que l'autorité humaine décide.

La finalité n'est pas de faire travailler davantage d'IA. Elle est de **produire
une connaissance plus fiable du système avant d'agir sur lui**.

Le maintien d'un désaccord est un résultat légitime, jamais un échec du
dispositif.
