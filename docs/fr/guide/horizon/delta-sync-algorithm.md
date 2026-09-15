# Algorithme Delta Sync et Sauvegardes Incrémentales

<div style="display: flex; gap: 8px; margin: 1rem 0; flex-wrap: wrap;">
  <img src="https://img.shields.io/badge/Algorithme-Delta%20Diff%C3%A9rentiel-blue.svg" alt="Algorithme" />
  <img src="https://img.shields.io/badge/Hachage-SHA--256-green.svg" alt="Hachage" />
  <img src="https://img.shields.io/badge/Gestion-Consolidation%20Automatique-orange.svg" alt="Gestion" />
</div>

Le cœur technologique de Gens-Horizon repose sur son moteur de synchronisation différentielle (**Delta Sync**) implémenté dans `scanner.js`, `upload.js`, `sync.js` et `cloud-operations.js`.

---

## 1. Balayage Local Haute Performance (`scanner.js`)

Le balayage d'une instance Minecraft (qui peut compter plus de 20 000 fichiers entre les régions du monde, les textures et les mods) doit être quasi-instantané pour ne pas faire attendre le joueur :

1. **Pré-filtre Rapide (mtime et taille) :**
   Avant de calculer un hash cryptographique coûteux, le scanner compare la date de dernière modification (`mtimeMs`) et la taille en octets du fichier par rapport au dernier manifeste connu. Si ces deux valeurs sont identiques, l'ancien hash est conservé sans relecture du disque.
2. **Hachage SHA-256 en Flux Asynchrone :**
   Pour les fichiers nouveaux ou modifiés, un hachage SHA-256 est calculé via un flux de lecture Node.js (`fs.createReadStream`).
3. **Limiteur de Concurrence (`withConcurrency`) :**
   Pour éviter d'épuiser les descripteurs de fichiers système sous Linux ou Windows (`EMFILE: too many open files`), les lectures de fichiers sont soumises à une file d'attente concurrente bornée (généralement 16 à 32 opérations simultanées maximum).

---

## 2. Détection des Différences et Création du Delta (`upload.js`)

Lorsqu'un envoi vers le cloud est déclenché :

```
[ Manifeste Local Actuel ]  vs  [ Dernier Manifeste Synchronisé ]
             |                                |
             +----------------+---------------+
                              |
                              v
                [ Différenciation en 3 listes ]
                - Fichiers ajoutés (ADDED)
                - Fichiers modifiés (MODIFIED)
                - Fichiers supprimés (DELETED)
```

1. **Génération du Bundle Delta :**
   Seuls les fichiers marqués `ADDED` ou `MODIFIED` sont archivés dans un fichier ZIP nommé selon la convention :
   `GensHorizon_Delta_<timestamp>_<hash>.zip`
2. **Métadonnées et Suppressions :**
   Un fichier de métadonnées léger (`GensHorizon_Meta_<timestamp>.json`) accompagne l'archive pour lister explicitement les fichiers `DELETED` qui doivent être supprimés localement sur les autres machines.
3. **Téléversement Cible :**
   Le delta (généralement compris entre quelques kilo-octets et 2 Mo) est envoyé vers le dossier distant du fournisseur cloud.

---

## 3. Application Chronologique des Deltas (`sync.js`)

Lorsqu'une autre machine se synchronise pour récupérer l'instance :

1. **Interrogation de l'Index Cloud :**
   `sync.js` récupère la liste complète des deltas distants via le fournisseur cloud.
2. **Tri Chronologique :**
   Tous les deltas postérieurs au dernier état local de la machine sont triés par ordre chronologique strict.
3. **Application Séquentielle :**
   Pour chaque delta manquant :
   - L'archive ZIP est téléchargée dans un répertoire temporaire.
   - Les fichiers sont extraits et écrasent les anciennes versions locales.
   - Les fichiers listés dans les métadonnées de suppression sont retirés du disque.
   - Le manifeste local est mis à jour.
4. **Validation de Fin :**
   L'instance locale est désormais strictement identique à la dernière version jouée sur la machine d'origine.

---

## 4. Nettoyage et Consolidation Automatique (`cloud-operations.js`)

Au fil des sessions, le nombre de petits fichiers deltas distants peut augmenter. Pour préserver les quotas de requêtes API et l'espace de stockage :

- **`getCloudIndexAndCleanDuplicates()` :** Cette fonction analyse l'arborescence cloud, identifie les fragments obsolètes et supprime les doublons accidentels résultant d'interruptions réseau.
- **Seuil de Consolidation (`deltaCleanupThreshold`) :** Lorsque le nombre de deltas accumulés dépasse le seuil configuré (par défaut 10 sessions), le moteur fusionne l'ensemble de l'historique dans un nouveau point d'ancrage complet (`GensHorizon_Backup_<timestamp>.zip`) et purge les deltas antérieurs devenus redondants.
