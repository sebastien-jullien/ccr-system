# Contribuer à CCR

Les signalements et les propositions de changement sont bienvenus.

Ce document décrit ce que le projet attend d'une contribution. Il ne remplace ni
la doctrine ([`docs/doctrine.md`](docs/doctrine.md)), ni les spécifications
([`docs/specs/`](docs/specs/)) : celles-ci restent la référence normative.

---

## Avant d'écrire du code

Deux lectures évitent la plupart des allers-retours :

- [`docs/doctrine.md`](docs/doctrine.md) — ce que CCR affirme, et surtout ce
  qu'il refuse d'affirmer ;
- la spécification du domaine concerné, si votre changement touche la
  controverse, les matériaux ou la réconciliation.

Une contribution qui respecte le code mais contredit la doctrine sera refusée,
même si elle fonctionne.

---

## Signalements

Un bon signalement décrit :

- ce que vous attendiez ;
- ce qui s'est produit ;
- comment le reproduire ;
- votre version de Node et votre système.

**Ne joignez jamais** de contenu de run réel, de transcription de session
d'expert, d'identifiant de session fournisseur ni de chemin de votre poste. Ces
données vous appartiennent et n'ont pas à circuler dans un signalement public.

---

## Changements

**Un changement, un objet.** Une correction et un réusinage dans la même
proposition sont deux discussions qui s'empêchent mutuellement.

**Constat n'est pas remède.** Repérer un problème et décider de la manière de le
corriger sont deux actes distincts. Ouvrir un signalement pour le premier est
toujours légitime, y compris sans proposer le second.

**Aucun changement sémantique silencieux.** Si votre modification change ce que
CCR affirme, enregistre, ou ce qu'un utilisateur peut en conclure, dites-le
explicitement dans la description. Un changement de comportement présenté comme
un nettoyage est le seul type de contribution que le projet refuse par principe.

**Les contrats publics se documentent.** Si vous changez une surface décrite dans
`docs/`, la documentation change dans la même proposition.

---

## Tests

Les tests sont attendus dès qu'un changement touche un comportement observable.

```bash
npm install
npm run typecheck
npm test
```

`npm test` n'appelle aucun fournisseur : il s'exécute hors ligne, sur des doubles
contrôlés et des répertoires temporaires.

**Campagnes consommatrices.** `npm run test:integration` sollicite les CLI
fournisseurs réelles et **consomme de la ressource** sur vos comptes. Ne la
lancez jamais par réflexe, ni pour vérifier un changement sans rapport. Elle se
lance volontairement, dans un environnement prévu à cet effet.

Une preuve vaut par ce qu'elle a réellement observé. Un test qui passe sur un
double ne démontre pas un comportement réel, et le dire est attendu.

---

## Attestation d'origine — DCO

Ce projet exige un **sign-off DCO** (Developer Certificate of Origin) sur chaque
commit. Il n'y a **pas de CLA**, et aucune cession de droits n'est demandée.

En signant, vous certifiez que vous avez le droit de soumettre votre
contribution sous la licence du projet.

Ajoutez à chaque message de commit une ligne :

```text
Signed-off-by: Prénom Nom <adresse@exemple.org>
```

La plupart des outils l'ajoutent avec l'option `-s` de `commit`.

Le texte intégral du Developer Certificate of Origin 1.1 est disponible sur
<https://developercertificate.org/>.

---

## Licence des contributions

Les contributions sont apportées sous la licence du projet, **MPL-2.0**
([`LICENSE`](LICENSE)).

Vous conservez la paternité de votre travail. Le projet ne demande ni transfert
de propriété, ni assignation de copyright.

---

## Décision

Le mainteneur principal est **Sébastien JULLIEN**. Aucune structure de
gouvernance supplémentaire n'est en place à ce stade ; elle sera décrite ici si
elle est établie un jour.
