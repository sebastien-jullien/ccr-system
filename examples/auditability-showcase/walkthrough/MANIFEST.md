# Manifeste d'exécution et note d'expurgation

**Manifeste curé.** Ce document relie ce qui a été transmis au run canonique
`CCR-20260901-002` à ce qui est publié ici, et déclare ce qui en a été retiré.

```text
RUN CANONIQUE        CCR-20260901-002
ANNEXE DE QUOTA      CCR-20260901-001
COMMIT D'EXÉCUTION   780756b45330b7cd0cc268acbb6d0b375447577b
RUN BRUT             NON VERSIONNÉ
```

Ce manifeste n'est **pas** un manifeste de run brut : il ne reproduit aucun
journal. Il publie les empreintes du prompt transmis et des deux réponses
d'expert. Le récit de la traversée se lit dans
[`run-CCR-20260901-002.md`](run-CCR-20260901-002.md).

---

## Statut des fichiers publics

```text
FICHIERS DE CE PAQUET   projections / extraits expurgés
                        ≠  journaux CCR faisant autorité

ARTEFACTS ORIGINAUX     les seules autorités durables
```

Expurger et extraire ne crée aucune autorité nouvelle. Une présentation n'est
pas une autorité métier. En cas d'écart entre une page de ce paquet et un
artefact original du run, l'artefact prévaut.

---

## Prompt transmis

```text
octets           558
sha256           2448ef39f6a61ce9654e2db5d2738ee7e25a0fb3beae60161bc6926643f0909e
transmis par     evt_000002 (author)  ·  evt_000005 (challenger)
```

Les deux événements de prompt portent la **même empreinte** : la fourniture est
identique à l'octet pour les deux slots. Le texte intégral est publié au § 4 du
compte rendu — c'est le sujet gelé de la traversée, et rien n'y est expurgé.

Conséquence de la conception native de CCR : `start` transmet un seul prompt,
identique aux deux slots. Aucune différenciation cognitive `author` /
`challenger` n'est émise à cette étape.

---

## Réponses d'expert

Deux réponses, un tour, deux slots. Empreintes calculées sur le contenu
canonique tel qu'il est persisté.

| événement | slot | moteur | octets | sha256 |
|---|---|---|--:|---|
| `evt_000003` | author | Claude | 10 190 | `f7702ae494d5c7be443557991c4bbc4181bc343b368d5dd84f10be055b272749` |
| `evt_000006` | challenger | Codex | 6 920 | `192d6cb10af0aae53dd7d90318bf52a9a6cfa25bb5268442a0354c59124ae225` |

Le **contenu** de ces réponses n'est pas publié dans ce dépôt. Ces empreintes
identifient ce qui a été produit ; elles ne le reproduisent pas.

Ce choix est délibéré et vaut aussi pour les extraits : publier des fragments
choisis de deux positions, alors qu'aucune controverse n'a été enregistrée et
qu'aucun acte CCR ne les a comparées, reviendrait à fabriquer un accord ou un
désaccord que la traversée n'établit pas.

```text
SORTIE FOURNISSEUR  =  MATÉRIAU ARGUMENTATIF
                    ≠  décision produit
                    ≠  adoption architecturale
                    ≠  autorité humaine
```

---

## Note d'expurgation

Catégories de champs retirés ou remplacés par un jeton dans tout le paquet. Les
valeurs d'origine ne sont pas publiées, ici ni ailleurs.

| Catégorie | Jeton | Motif |
|---|---|---|
| Chemin absolu du workspace | `<REDACTED_WORKSPACE>` | propre au poste, n'enseigne rien de CCR |
| Identifiants de session native | `<REDACTED_SESSION_ID>` | identifiants fournisseur, propres à l'exécution |
| Chemin absolu du fichier de prompt | `<REDACTED_PROMPT_FILE>` | chemin local d'invocation |
| État d'authentification préalable | `<REDACTED_AUTH_STATE>` | métadonnée d'authentification |
| Autres chemins locaux absolus | jeton adapté | propres au poste |

Retirés sans substitution, parce qu'ils n'apparaissent dans aucun extrait
publié : identifiants de processus, identifiants de verrou, noms de machine,
noms d'utilisateur, variables d'environnement, montants facturés, données
personnelles. Aucun secret, jeton ou élément d'authentification n'a été lu,
copié ni publié à quelque étape que ce soit.

### Ce que l'expurgation n'a pas touché

```text
run_id · invocation_id · evt_…        PRÉSERVÉS
chiffres de quota                     PRÉSERVÉS
états et faits de statut              PRÉSERVÉS
horodatages de l'ordre causal         PRÉSERVÉS
relations d'autorité                  PRÉSERVÉES
```

Ces localisateurs sont publics par choix : ils permettent de relier les faits
entre eux et de vérifier la cohérence du récit sans exposer quoi que ce soit du
poste d'exécution.

Les noms de fournisseurs — Claude, Codex — sont publiés : ils font partie de la
gouvernance du run.

---

## Ce que ce manifeste ne gèle pas

Fournisseur · arrangement des moteurs · plafond d'invocations · répertoire de
travail · politique de reprise · commande de lancement · enveloppe d'exécution de
l'opérateur.

Ces choix sont humains et propres à une exécution. Ils ont été arrêtés au moment
de lancer `CCR-20260901-002`, et ne font pas partie d'un matériau gelé
réutilisable : un autre opérateur, avec le même sujet, en ferait d'autres.

---

## Reproductibilité

**Reproductible depuis ce dépôt :** le sujet gelé et son prompt exact, avec son
empreinte.

**Historique, non reproductible :** les réponses des fournisseurs, la traversée
elle-même, et le comportement futur d'un fournisseur quel qu'il soit.

**Non versionné :** le run brut. `.ccr/` est ignoré par Git, et aucun export n'en
figure dans ce dépôt.

Rejouer ce sujet produira **une autre traversée**. Aucune reproduction à
l'identique d'une sortie de fournisseur n'est promise.
