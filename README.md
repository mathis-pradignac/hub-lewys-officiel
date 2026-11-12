# Lewys Hub

Plateforme interne de l'équipe Lewys, prête pour Netlify. Les comptes et les données de l'équipe sont enregistrés sur le serveur du Hub (stockage intégré à Netlify) et partagés entre tous les postes.

## Mise en ligne

### 1. GitHub
1. Sur github.com : **New repository**, nom `lewys-hub`, visibilité **Private**, puis **Create repository**.
2. Sur la page du dépôt : **uploading an existing file**, puis glissez **tout le contenu** de ce dossier (fichiers et dossiers `public` et `netlify`). Validez avec **Commit changes**.

Le dépôt doit rester privé : le dossier `netlify/lib` contient la liste de départ de vos clients.

### 2. Netlify
1. **Add new project → Import an existing project → GitHub**, puis choisissez `lewys-hub`.
2. Ne changez aucun réglage (ils sont lus dans `netlify.toml`) et cliquez sur **Deploy**.
3. Dans **Project configuration**, donnez un nom au site, par exemple `lewys-hub` : l'adresse devient `https://lewys-hub.netlify.app`.

### 3. Première connexion (à faire tout de suite)
Ouvrez l'adresse du Hub et connectez-vous avec le compte administrateur provisoire (`mathis` / `Lewys2026!`). Le Hub vous demande aussitôt un nouveau mot de passe. Tant que ce n'est pas fait, ce mot de passe provisoire est valable : ne tardez pas.

### 4. Équipe
Administration → Équipe : créez un compte par personne, avec un mot de passe provisoire à lui transmettre. Chacun le changera à sa première connexion.

### 5. Google (mails, Drive, agenda en lecture seule)
Administration → Connexions & temps : suivez le guide de la page pour créer l'identifiant Google, en indiquant l'adresse du Hub comme origine autorisée.

### 6. Claude
Chaque personne ouvre « Mes connexions » (en bas du menu) et colle sa clé API Claude.

## Mettre à jour le Hub
Remplacez les fichiers dans le dépôt GitHub : Netlify republie le site automatiquement en une minute. Les données de l'équipe ne sont pas touchées.

## Ce qui est partagé

| Donnée | Qui peut la modifier |
|---|---|
| Comptes, rôles, outils, droits, sources de presse, message d'équipe | L'administrateur |
| Nom, poste, photo, mot de passe | Chaque personne, pour son compte |
| Heures du jour | Chaque personne, pour elle-même |
| Suivi client | L'administrateur partout ; chaque RM sur ses propres saisies |
| Budget, Groupes, Audits | Les personnes dont le rôle a accès au module |
| Notes « À ne pas oublier » | Chaque personne (privées) |
| Revue de presse | Mise à jour par le serveur toutes les heures |

Restent dans le navigateur de chaque personne : sa clé Claude, sa session Google et sa conversation avec Mira.

## Sécurité

- Les mots de passe sont vérifiés par le serveur et jamais renvoyés au navigateur. Huit erreurs de suite bloquent le compte cinq minutes.
- La session dure 12 heures.
- Gmail, Drive et Agenda sont en lecture seule : le Hub ne demande à Google que les droits `gmail.readonly`, `drive.readonly`, `calendar.readonly`. Mira ne peut rien envoyer, modifier ni supprimer.
- Les pages du Hub sont accessibles à qui connaît l'adresse, mais aucune donnée ne s'affiche sans connexion.

## Limites connues

- Les données du Suivi client (honoraires, coûts horaires) sont envoyées en entier au navigateur de chaque personne connectée, même si l'écran d'un RM n'en montre qu'une partie.
- La session Google dure une heure, puis demande un clic sur « Reconnecter ».
- Il n'y a pas encore de sauvegarde automatique des données : pensez à exporter régulièrement (Administration → Sauvegarde, et l'export du Suivi client).

## Contenu du dossier

| Élément | Rôle |
|---|---|
| `public/` | Les pages du Hub et des modules |
| `netlify/functions/api.mjs` | Le serveur : connexion et données partagées |
| `netlify/functions/press-refresh.mjs` | Mise à jour horaire de la revue de presse |
| `netlify/lib/` | Logique du serveur et données de départ du Suivi client |
| `netlify.toml`, `package.json` | Réglages lus par Netlify |
| `dev-server.mjs` | Test sur un poste : `npm run dev`, puis `http://localhost:8888` |
| `public/hub-bridge.js` | Facultatif : à ajouter aux applications hébergées ailleurs pour que Mira lise leur page |
