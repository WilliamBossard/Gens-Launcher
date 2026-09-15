# Fournisseurs Cloud et Authentification

<div style="display: flex; gap: 8px; margin: 1rem 0; flex-wrap: wrap;">
  <img src="https://img.shields.io/badge/Pattern-Provider%20Factory-blue.svg" alt="Pattern" />
  <img src="https://img.shields.io/badge/Fournisseurs-Google%20%7C%20Dropbox%20%7C%20OneDrive-green.svg" alt="Fournisseurs" />
  <img src="https://img.shields.io/badge/S%C3%A9curit%C3%A9-Hardware--Bound%20Tokens-red.svg" alt="Sécurité" />
</div>

Gens-Horizon a été conçu pour être totalement agnostique du service de stockage distant. Grâce au design pattern **Factory** implémenté dans `provider.js`, le moteur délègue toutes les opérations d'entrée/sortie à des adaptateurs dédiés situés dans le dossier `/providers`.

---

## 1. Le Pattern Provider Factory (`provider.js`)

Chaque adaptateur cloud implémente une interface uniforme commune :

```javascript
class BaseCloudProvider {
    async login() {}                           // Déclenche le flux d'autorisation OAuth2
    async getQuota() {}                         // Retourne { total, used, free }
    async listFiles(prefix) {}                  // Liste les deltas et métadonnées distants
    async uploadFile(localPath, remoteName) {}  // Téléversement avec reprise
    async downloadFile(remoteName, destPath) {} // Téléchargement en flux direct
    async deleteFile(fileId) {}                 // Suppression d'un artefact distant
    async refreshTokenIfNeeded() {}             // Renouvellement silencieux du bearer token
}
```

La fonction `getProvider(name)` instancie dynamiquement la classe appropriée en fonction du paramètre configuré dans `horizon_settings.json` :
- `'google'` -> `providers/google.js`
- `'dropbox'` -> `providers/dropbox.js`
- `'onedrive'` -> `providers/onedrive.js`

---

## 2. Implémentations Spécifiques

### Google Drive (`providers/google.js`)
- Utilise l'API Google Drive v3 via des requêtes REST pures sans SDK tiers lourd.
- Stocke les données de jeu dans un dossier d'application dédié `GensHorizon/` à la racine de Google Drive (ou dans le conteneur privé `appDataFolder`).
- Gère l'upload en mode multipart pour les petits deltas et en upload résumable pour les consolidations volumineuses.

### Dropbox (`providers/dropbox.js`)
- Utilise les endpoints de l'API Dropbox v2 (`/2/files/upload`, `/2/files/download`).
- Exploite le système de hash natif Dropbox pour valider l'intégrité de bout en bout des fichiers transférés.
- Gère les jetons d'accès courts avec rafraîchissement automatique via le point d'accès OAuth2 de Dropbox.

### Microsoft OneDrive (`providers/onedrive.js`)
- Utilise l'API Microsoft Graph (`/me/drive/special/approot` ou dossier ciblé).
- Intègre la création automatique de sessions de téléversement (`createUploadSession`) pour supporter les connexions réseau instables.

---

## 3. Stratégie de Rejeu et Tolérance aux Pannes (`retry.js`)

Pour faire face aux coupures de réseau transitoires, aux saturations de bande passante et aux limites de débit (*Rate Limiting* 429 ou erreurs 503), tous les appels réseau passent par un wrapper adaptatif :
- **Backoff Exponentiel :** Délai initial (`retryBaseDelay: 1500 ms`) multiplié par un facteur avec injection d'une variation aléatoire (*jitter*) pour éviter la tempête de requêtes simultanées.
- **Nombre de Tentatives Configurable :** Par défaut 3 tentatives avant déclaration d'échec propre.
- **Détection des Erreurs Fatales :** Les erreurs d'authentification définitive (401 non résolue après rafraîchissement) arrêtent immédiatement la boucle sans épuiser inutilement les quotas.

---

## 4. Chiffrement Matériel des Jetons (`Auth.js`)

Les identifiants et jetons d'accès distants ne sont **jamais stockés en clair** sur le disque de la machine :

1. Au premier lancement, Gens-Horizon génère un identifiant machine unique et inviolable de 256 bits (`crypto.randomBytes(32)`) stocké dans `.machine_id`.
2. Un sel cryptographique indépendant de 16 octets est enregistré dans `salt.key` avec des droits d'accès restreints (`mode: 0o600`).
3. Une clé symétrique de 256 bits est dérivée via **PBKDF2** à 600 000 itérations en utilisant le contenu de `.machine_id` comme mot de passe.
4. Les jetons OAuth2 sont chiffrés en **AES-256-GCM** avec un vecteur d'initialisation (IV) de 12 octets renouvelé à chaque écriture.

::: tip Protection contre le vol de dossier
Même si un tiers venait à copier l'intégralité du dossier Gens-Horizon sur une clé USB, il lui serait mathématiquement impossible de déchiffrer les jetons cloud sur une autre machine sans posséder le fichier système `.machine_id` propre au matériel d'origine.
:::
