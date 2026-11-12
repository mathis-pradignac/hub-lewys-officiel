# Afficher le Studio et le Site web dans le Hub

Ces deux outils refusent aujourd'hui de fonctionner à l'intérieur du Hub. Le réglage se fait dans **leur** code, pas dans celui du Hub.
Remplacez partout `https://ADRESSE-DU-HUB` par l'adresse réelle du Hub (par exemple `https://lewys-hub.netlify.app`).

## 1. Le Studio Lewys (Payload CMS)

**Constat** : la page s'affiche, mais après la connexion on revient à l'écran de connexion. Le cookie de session n'est pas renvoyé par le navigateur quand le Studio est affiché dans un autre site.

**Correction** : dans la collection des utilisateurs (souvent `src/collections/Users.ts`), autoriser le cookie hors du site :

```ts
export const Users: CollectionConfig = {
  slug: 'users',
  auth: {
    cookies: {
      sameSite: 'None', // le cookie est accepté quand le Studio est affiché dans le Hub
      secure: true,     // obligatoire avec sameSite None (le Studio est bien en https)
    },
  },
  // … le reste ne change pas
}
```

Puis redéployez le Studio et reconnectez-vous.

## 2. Le Site web Lewys (administration Strapi, lewys.fr/admin)

**Constat** : la page est bloquée. Le site envoie `X-Frame-Options: SAMEORIGIN` et `frame-ancestors 'self'`, qui n'autorisent l'affichage que sur lewys.fr.

**Correction** : dans `config/middlewares.js` (ou `.ts`), dans le réglage `strapi::security` qui existe déjà, ajouter les deux lignes marquées :

```js
{
  name: 'strapi::security',
  config: {
    frameguard: false, // AJOUT : retire X-Frame-Options
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        // … vos directives actuelles restent telles quelles …
        'frame-ancestors': ["'self'", 'https://ADRESSE-DU-HUB'], // AJOUT : autorise le Hub
      },
    },
  },
},
```

Puis redéployez le site.

Si, après cela, la connexion revient en boucle comme pour le Studio, il faudra aussi autoriser le cookie de session de l'administration hors du site (`sameSite: 'none'`). L'emplacement exact dépend de la version de Strapi : à vérifier sur le projet.

## 3. Rapports (pour mémoire)

Le site Rapports envoie `X-Frame-Options: DENY`. Dans son `netlify.toml` ou son fichier `_headers`, remplacer cette ligne par :

```
Content-Security-Policy: frame-ancestors 'self' https://ADRESSE-DU-HUB
```

## À savoir

- Safari et la navigation privée bloquent souvent les cookies d'un site affiché dans un autre. Sur ces navigateurs, la connexion au Studio ou au Site web peut continuer d'échouer dans le Hub : le mode « Onglet » reste alors la solution.
- Une fois les corrections en ligne, repassez ces outils en « Intégré » dans Administration → Outils & droits.
