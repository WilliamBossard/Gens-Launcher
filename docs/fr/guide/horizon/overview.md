# Gens-Horizon : Architecture du Moteur Cloud

<div style="display: flex; gap: 8px; margin: 1rem 0; flex-wrap: wrap;">
  <img src="https://img.shields.io/badge/Moteur-CLI%20Headless-blue.svg" alt="Moteur" />
  <img src="https://img.shields.io/badge/Protocole-IPC%20JSON%20Stream-green.svg" alt="Protocole" />
  <img src="https://img.shields.io/badge/Stockage-Agnostique-orange.svg" alt="Stockage" />
</div>

**Gens-Horizon** (`C:\dev\Gens-Horizon`) est le moteur de synchronisation cloud déporté et autonome (« headless ») de l'écosystème Gens. Conçu pour s'exécuter en tâche de fond en tant que sous-processus de Gens-Launcher, il gère la synchronisation bidirectionnelle, le versionnement et la restauration des instances Minecraft avec les fournisseurs cloud majeurs (Google Drive, Dropbox, OneDrive).

---

## 1. Rôle et Philosophie de Conception

Dans la plupart des lanceurs traditionnels, la sauvegarde cloud se limite à compresser l'intégralité du dossier du jeu dans une archive de plusieurs centaines de mégaoctets et à l'envoyer sur un serveur. Cette méthode entraîne une consommation excessive de bande passante, des temps d'attente prolongés et des risques de saturation d'espace.

Gens-Horizon résout ce problème grâce à :
- Une synchronisation différentielle fine (**Delta Sync**) : seuls les blocs et fichiers altérés sont empaquetés et téléversés.
- Une indépendance totale vis-à-vis de l'interface graphique : le moteur peut être compilé sous forme de binaire autonome (`pkg`) ou exécuté en CLI pure.
- Une conception agnostique du fournisseur cloud via le pattern Factory.
- Une résilience accrue face aux pannes réseau et aux arrêts inopinés grâce à des verrous atomiques et un protocole de battement de cœur.

---

## 2. Topologie des Composants

L'architecture interne de Gens-Horizon s'articule autour des modules suivants :

```
                                  [ CLI / Launcher IPC ]
                                             |
                                             v
                                        index.js
                                             |
         +-----------------+-----------------+-----------------+
         |                 |                 |                 |
         v                 v                 v                 v
      check.js          sync.js          upload.js        rollback.js
         |                 |                 |                 |
         +-----------------+--------+--------+-----------------+
                                    |
                                    v
                            scanner.js (SHA-256)
                                    |
                                    v
                           provider.js (Factory)
                     /              |              \
                    v               v               v
             providers/google  providers/dropbox  providers/onedrive
                                    |
        +---------------------------+---------------------------+
        |                           |                           |
        v                           v                           v
     lock.js                     Auth.js               cloud-operations.js
(Verrous atomiques)        (PBKDF2 / AES-GCM)        (Index & Nettoyage)
```

- **`index.js`** : Routeur CLI principal. Intercepte `console.log/warn` pour rediriger les sorties textuelles des bibliothèques vers `process.stderr`, préservant la pureté du flux JSON sur `process.stdout`.
- **`scanner.js`** : Moteur de balayage local haute performance. Calcule les empreintes SHA-256 avec un limiteur de concurrence (`withConcurrency`) pour éviter l'épuisement des descripteurs de fichiers (`EMFILE`).
- **`upload.js`** : Détecte les modifications locales par rapport au dernier état connu, crée une archive delta ciblée et l'envoie sur le cloud.
- **`sync.js`** : Interroge l'index distant, télécharge chronologiquement les deltas manquants et les applique localement.
- **`cloud-operations.js`** : Centralise la manipulation de l'index distant et assure la purge automatique des sauvegardes en double ou obsolètes (`getCloudIndexAndCleanDuplicates`).
- **`rollback.js`** : Reconstruit l'historique de manière déterministe pour restaurer une instance à n'importe quel point de sauvegarde antérieur.
- **`zip-utils.js`** : Décompression ultra-optimisée en mémoire basée sur `yauzl`, intégrant une vérification stricte anti-Path Traversal et la validation de l'en-tête binaire zip (`0x504B0304`).

---

## 3. Protocole de Communication IPC JSON

Gens-Horizon communique avec Gens-Launcher via ses flux standard `stdout` et `stdin`. Tous les messages émis sur `stdout` sont strictement formatés en JSON unitaire :

```json
{
  "type": "PROGRESS",
  "step": "COMPRESSING",
  "value": 65,
  "instance": "Survie_Folia"
}
```

### Types d'événements supportés :
- `PROGRESS` : Progression d'étape (`SCANNING`, `COMPRESSING`, `UPLOADING`, `APPLYING_DELTA`).
- `INFO` : Messages d'information textuels.
- `SUCCESS` : Notification de fin d'opération avec métadonnées de synchronisation.
- `ERROR` : Signalement d'anomalie avec code d'erreur typé.
- `ROLLBACK_LIST` : Énumération chronologique des deltas disponibles pour restauration.
- `CHECK_RESULT` : Bilan comparatif entre l'état local et l'état distant.
- `CLOUD_LIST` : Inventaire complet des instances synchronisées sur le cloud.
