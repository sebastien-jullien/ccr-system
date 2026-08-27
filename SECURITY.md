# Sécurité

## Signaler une vulnérabilité

Aucun canal de signalement privé dédié n'est encore en place pour ce projet.

En attendant qu'un tel canal existe, utilisez le mécanisme de signalement privé
de vulnérabilité de la forge qui héberge le dépôt, s'il est activé. À défaut,
ouvrez un signalement public **sans y inclure d'élément exploitable** : décrivez
la nature du problème et la surface concernée, et attendez qu'un canal privé vous
soit indiqué avant de transmettre les détails.

Ce projet est une R&D indépendante maintenue par une seule personne. Aucun délai
de réponse, aucune prime, aucun accord d'embargo et aucun engagement de service
ne sont promis.

## Périmètre

CCR est un **outil local**. Il n'expose aucun service distant et n'est pas conçu
pour être hébergé.

Quatre frontières valent d'être connues avant tout signalement.

**Cockpit local.** Le cockpit écoute uniquement sur `127.0.0.1` et n'est pas
conçu pour être exposé. Une exposition délibérée sur le réseau sort du périmètre
de conception du produit.

**Authentification des fournisseurs.** Elle est entièrement déléguée aux CLI
officielles des fournisseurs. CCR n'extrait aucun jeton, ne lit aucun magasin de
secrets, n'en persiste aucun, et n'affaiblit jamais les protections que ces
outils appliquent.

**Contenu produit par un modèle.** Il est traité comme non fiable : analysé,
converti, puis construit nœud par nœud — jamais concaténé comme du balisage. Le
balisage brut est rendu en texte, aucune ressource externe n'est chargée, et un
lien reçu d'un tiers reste du texte tant qu'aucune analyse ne l'a autorisé.

**Workspace.** Le workspace est le répertoire de travail associé à un run : le
contexte depuis lequel les experts sont lancés. **Ce n'est pas une frontière de
sécurité.** CCR ne surveille pas et ne restreint pas ce que les CLI fournisseurs
lisent sur le disque. Aucun confinement, aucun bac à sable et aucune isolation du
système de fichiers n'est promis — un signalement fondé sur l'absence d'une telle
garantie décrit le comportement documenté, pas une vulnérabilité.

## Hors périmètre

- L'exposition volontaire du cockpit sur un réseau.
- L'accès d'une CLI fournisseur à des fichiers hors du workspace.
- Les vulnérabilités des CLI fournisseurs elles-mêmes, qui relèvent de leurs
  éditeurs respectifs.
