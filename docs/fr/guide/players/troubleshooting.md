# FAQ et Dépannage

<div style="display: flex; gap: 8px; margin: 1rem 0; flex-wrap: wrap;">
  <img src="https://img.shields.io/badge/Support-GitHub%20Issues-blue.svg" alt="Support" />
  <img src="https://img.shields.io/badge/Statut-Open%20Source-green.svg" alt="Statut" />
</div>

Ce guide rassemble les solutions aux questions et incidents les plus fréquemment rencontrés lors de l'utilisation de Gens Launcher.

---

## Questions Fréquemment Posées (FAQ)

### Gens Launcher prend-il en charge les comptes hors-ligne ?
**Oui.** Bien que nous recommandions l'utilisation d'un compte officiel Microsoft pour profiter des serveurs sécurisés et de la synchronisation de skins, Gens Launcher intègre un mode hors-ligne complet permettant de jouer en local ou sur des réseaux privés.

### Pourquoi Windows affiche-t-il l'écran bleu SmartScreen lors de l'installation ?
Gens Launcher est un projet indépendant open-source. L'obtention d'un certificat commercial Windows EV coûte plusieurs centaines d'euros par an. Cliquez simplement sur **« Informations complémentaires »** puis sur **« Exécuter quand même »**. L'intégralité du code est vérifiable sur GitHub.

### Est-ce que mes identifiants Microsoft sont en sécurité ?
**Oui, totalement.** Gens Launcher utilise le flux officiel OAuth2 Device Code de Microsoft. Le lanceur ne voit jamais votre mot de passe. Vos jetons de session sont chiffrés sur votre disque via les API sécurisées de votre système d'exploitation (`safeStorage` ou AES-256-GCM dérivé par PBKDF2 à 600 000 itérations).

### Gens Launcher est-il gratuit ?
**Oui, 100% gratuit et sans publicité.** Le projet est distribué sous la licence libre MIT. Il ne comporte aucune télémétrie commerciale ni revente de données.

---

## Problèmes Courants et Solutions

### 1. Le jeu refuse de démarrer (Erreur Java ou crash immédiat)
- **Vérifiez la version de Java :**
  Minecraft 1.20.5+ requiert Java 21 ou Java 25. Minecraft 1.18 à 1.20.4 requiert Java 17. Minecraft 1.16 requiert Java 8.  
  Rendez-vous dans les *Paramètres de l'Instance* et laissez Gens Launcher télécharger automatiquement le bon runtime Java.
- **Vérifiez la mémoire vive allouée (RAM) :**
  Une allocation insuffisante (moins de 2 Go) peut provoquer un `java.lang.OutOfMemoryError`. Inversement, n'allouez pas plus de la moitié de votre RAM totale système pour éviter de bloquer votre système d'exploitation.
- **Incompatibilité de mods :**
  Consultez l'onglet *Logs* de l'instance pour identifier le mod responsable du crash (généralement indiqué par `CrashReport` ou `MixinApplyError`). Désactivez le mod suspect via l'interrupteur dans l'onglet Mods.

### 2. Échec de la synchronisation Cloud Horizon
- **Vérifiez votre connexion réseau :**
  En cas de coupure Internet, le lanceur active automatiquement son mode hors-ligne et neutralise les appels cloud pour éviter de bloquer l'interface.
- **Message « Verrou actif » (horizon.lock) :**
  Si le jeu a été quitté brutalement ou si l'instance tourne sur un autre ordinateur, un verrouillage de sécurité protège vos fichiers. Si vous êtes certain qu'aucun autre processus ne tourne, vous pouvez débloquer l'instance via le bouton *Purger le verrou* dans les options avancées.
- **Expiration du jeton Cloud :**
  Si votre compte Google Drive, Dropbox ou OneDrive a révoqué l'accès, déconnectez puis reconnectez simplement le fournisseur dans les *Paramètres Horizon*.

### 3. Problèmes d'installation sur macOS
- **Erreur « Impossible d'ouvrir l'application car elle ne provient pas d'un développeur identifié » :**
  Faites un clic droit sur l'icône de Gens Launcher dans le dossier `/Applications`, sélectionnez **Ouvrir**, puis confirmez en cliquant sur **Ouvrir**. Cette confirmation n'est nécessaire qu'au premier lancement.

---

## Où trouver de l'aide ?

Si votre problème persiste :
1. Récupérez les journaux d'erreurs (Logs) depuis le menu *Aide / Journaux*.
2. Ouvrez un ticket transparent sur le [Dépôt GitHub Gens-Launcher Issues](https://github.com/WilliamBossard/Gens-Launcher/issues).
