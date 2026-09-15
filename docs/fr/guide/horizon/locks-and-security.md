# Verrous Atomiques et Sécurité d'Intégrité

<div style="display: flex; gap: 8px; margin: 1rem 0; flex-wrap: wrap;">
  <img src="https://img.shields.io/badge/Verrouillage-Atomique%20%2B%20Heartbeat-blue.svg" alt="Verrouillage" />
  <img src="https://img.shields.io/badge/S%C3%A9curit%C3%A9-Anti--Zip%20Slip-green.svg" alt="Anti-Zip Slip" />
  <img src="https://img.shields.io/badge/Restauration-Rollback%20D%C3%A9terministe-orange.svg" alt="Restauration" />
</div>

Dans un écosystème où plusieurs machines peuvent tenter d'accéder au même profil Minecraft sur le cloud, la prévention de la corruption de données et l'intégrité des archives décompressées constituent une priorité absolue.

---

## 1. Protocole de Verrouillage Atomique (`lock.js`)

Pour empêcher que deux instances de synchronisation ne s'exécutent simultanément sur le même dossier de jeu, Gens-Horizon applique un mécanisme de verrouillage physique strict :

```
[ Début de Synchronisation ]
              |
              v
    Tentative de création :
    fs.open('horizon.lock', O_CREAT | O_EXCL)
              |
       +------+------+
       |             |
   [ SUCCÈS ]    [ ÉCHEC (EEXIST) ]
       |             |
       |             v
       |    Inspection du Verrou Existant :
       |    - Le PID maître est-il encore en vie ? (kill(pid, 0))
       |    - Le verrou date-t-il de plus de 2 heures ? (STALE_LOCK_MS)
       |             |
       |      +------+------+
       |      |             |
       |  [ ACTIF ]   [ ORPHELIN / MORT ]
       |      |             |
       |   Abus de          v
       |   conflit    Purge du verrou
       |  (Arrêt)     & Recréation
       |                    |
       +--------------------+
              |
              v
[ Boucle Heartbeat toutes les 5 secondes ]
fs.promises.utimes('horizon.lock')
              |
              v
[ Fin de synchronisation : Suppression de horizon.lock ]
```

### Le Battement de Cœur (Heartbeat 5s)
Pendant toute la durée de la synchronisation (balayage, compression, téléversement), le processus maître met à jour la date de modification (`mtimeMs`) du fichier `horizon.lock` toutes les 5 secondes.

### Détection des Verrous Orphelins (Stale Locks)
Si l'ordinateur s'éteint brutalement ou si le processus Node.js est tué (`SIGKILL`), le fichier `horizon.lock` persiste sur le disque. Au prochain lancement, Gens-Horizon inspecte le verrou :
1. **Test d'activité du PID (`process.kill(pid, 0)`) :** Si le système d'exploitation confirme que le PID n'existe plus (`ESRCH`), le verrou est déclaré orphelin et purgé immédiatement.
2. **Seuil d'inactivité (2 heures) :** Même si le PID a été réaffecté par l'OS, un verrou dont le heartbeat date de plus de 2 heures (`STALE_LOCK_MS = 7200000`) est automatiquement invalidé.

### Couplage avec le Lanceur (`ipc-horizon.js`)
Le Main Process de Gens-Launcher lit également le `mtimeMs` de `horizon.lock` avant d'autoriser une action cloud depuis l'interface utilisateur. La cohérence des constantes (intervalle de 5s et seuil de 2h) est strictement maintenue entre les deux dépôts.

---

## 2. Décompression Sécurisée et Protection Anti-Zip Slip (`zip-utils.js`)

L'extraction d'archives ZIP distantes présente des risques majeurs si une archive malveillante contient des chemins relatifs piégés (ex: `../../../../Windows/System32`). Gens-Horizon neutralise cette menace :

1. **Validation Mathématique du Chemin d'Extraction :**
   ```javascript
   const resolvedTarget = path.resolve(destDir);
   const resolvedDest = path.resolve(destDir, entry.fileName);
   if (!resolvedDest.startsWith(resolvedTarget + path.sep) && resolvedDest !== resolvedTarget) {
       throw new Error(`Violation de sécurité Zip Slip : ${entry.fileName}`);
   }
   ```
2. **Contrôle de Signature Binaire :**
   Avant toute décompression, le moteur vérifie que le fichier commence bien par le marqueur magique ZIP `0x504B0304` (`PK\x03\x04`) et que le répertoire central (*Central Directory*) est lisible.
3. **Moteur `yauzl` :**
   L'extraction utilise `yauzl` pour traiter les flux d'entrée en continu sans charger l'intégralité du fichier ZIP en mémoire vive, évitant les crashs sur des modpacks volumineux.

---

## 3. Restauration Déterministe d'Historique (`rollback.js`)

En cas de problème en jeu, Gens-Horizon permet de remonter dans le temps :
- Chaque session de synchronisation crée un instantané identifié par son timestamp et son empreinte de manifeste.
- La commande `--rollback --instance "Nom" --target "<timestamp>"` reconstruit l'arborescence exacte de l'instance telle qu'elle existait à ce point précis, en rejouant ou en annulant chronologiquement les deltas nécessaires.
