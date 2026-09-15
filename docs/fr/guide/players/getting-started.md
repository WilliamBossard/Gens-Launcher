# Démarrage Rapide

<div style="display: flex; gap: 8px; margin: 1rem 0; flex-wrap: wrap;">
  <img src="https://img.shields.io/badge/Minecraft-Vanilla%20%26%20Moddé-green.svg" alt="Minecraft" />
  <img src="https://img.shields.io/badge/Plateforme-Windows%20%7C%20macOS%20%7C%20Linux-blue.svg" alt="Plateformes" />
  <img src="https://img.shields.io/badge/Licence-MIT-orange.svg" alt="Licence" />
</div>

Bienvenue sur la documentation officielle de **Gens Launcher**. Ce guide vous accompagne pas à pas dans la découverte du lanceur, la connexion à votre compte Minecraft et le lancement de votre première partie.

---

## Pourquoi Gens Launcher ?

Gens Launcher a été conçu pour allier **performance maximale**, **ergonomie moderne** et **sécurité sans compromis** :

- **Légèreté et fluidité :** Développé sans dépendances superflues, le lanceur démarre instantanément et consomme un minimum de ressources.
- **Gestion Multi-Modloaders :** Créez des profils **Vanilla**, **Fabric**, **Forge**, **Quilt** ou **NeoForge** en quelques clics sans configuration complexe.
- **Synchronisation Cloud Horizon :** Grâce au moteur compagnon **Gens-Horizon**, synchronisez automatiquement vos mondes, paramètres et mods avec Google Drive, Dropbox ou OneDrive.
- **Catalogue de Contenu Intégré :** Téléchargez mods, packs de textures et shaders directement depuis Modrinth et CurseForge.
- **Respect de la Vie Privée :** 100% open-source sous licence MIT, sans télémétrie ni pistage commercial.

---

## Connexion à votre Compte Minecraft

Gens Launcher prend en charge deux types d'authentification :

### 1. Compte Officiel Microsoft (Recommandé)
1. Cliquez sur le bouton **Se connecter avec Microsoft** situé en haut à droite de l'écran d'accueil.
2. Une fenêtre s'ouvre avec un code court (ex: `B49X-Y2K9`) et un lien vers `microsoft.com/link`.
3. Validez la connexion dans votre navigateur internet habituel avec votre compte Microsoft détenant Minecraft Java Edition.
4. Le lanceur détecte instantanément l'approbation, récupère votre skin 3D et chiffre vos identifiants en toute sécurité dans le trousseau de votre système d'exploitation.

::: tip Sécurité Maximale
Gens Launcher ne voit et ne stocke jamais votre mot de passe Microsoft. L'authentification utilise le protocole officiel OAuth2 Device Code Flow de Microsoft.
:::

### 2. Mode Hors-Ligne (Offline)
Si vous ne disposez pas d'une connexion Internet ou souhaitez jouer sur un réseau local :
1. Cliquez sur l'option **Mode Hors-Ligne / Pseudo Local**.
2. Renseignez simplement le pseudonyme de votre choix.
3. Vous pouvez lancer toutes vos instances préalablement installées.

---

## Découverte de l'Interface

L'interface de Gens Launcher est articulée autour de 4 zones clés :

1. **La Galerie d'Instances :** Présente visuellement toutes vos configurations de jeu avec leurs versions Minecraft, leurs modloaders et le statut de synchronisation cloud.
2. **Le Bouton d'Action Rapide :** Permet de lancer en un clic l'instance sélectionnée. Un simulateur dynamique affiche la progression détaillée (téléchargement des assets, patch Delta Sync, initialisation de la JVM).
3. **Le Gestionnaire de Contenu :** Onglet dédié pour ajouter des mods, shaders ou packs de textures en direct sans quitter le lanceur.
4. **Le Panneau Paramètres :** Personnalisation des thèmes, allocation de mémoire RAM, choix de la version de Java et association aux services Cloud.

---

## Étapes Suivantes

- [Guide d'Installation détaillé sur tous les systèmes d'exploitation](./installation)
- [Créer et configurer des Instances et installer des Mods](./instances-and-mods)
- [Activer la Synchronisation Cloud Horizon](./cloud-sync)
- [Résolution des problèmes fréquents](./troubleshooting)
