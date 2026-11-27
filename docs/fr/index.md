---
layout: home

hero:
  name: "Gens Launcher"
  text: "Redéfinissez votre expérience Minecraft."
  tagline: "Lanceur Minecraft open-source ultra-léger propulsé par Rust + Tauri v2, Gens-Horizon Delta Sync et une interface TypeScript stricte"
  image:
    src: /icon.png
    alt: Logo Gens Launcher
  actions:
    - theme: brand
      text: Télécharger
      link: /fr/#install
    - theme: alt
      text: Guide des Joueurs
      link: /fr/guide/players/getting-started
    - theme: alt
      text: Documentation Développeurs
      link: /fr/guide/dev/architecture
    - theme: alt
      text: Dépôt GitHub
      link: https://github.com/WilliamBossard/Gens-Launcher

features:
  - title: Horizon Delta Sync
    details: Moteur de synchronisation cloud déporté ne transférant que les octets modifiés pour des sauvegardes instantanées et légères.
  - title: Multi-Modloaders Intégrés
    details: Lancez facilement vos instances Vanilla, Fabric, Forge, Quilt et NeoForge avec détection et téléchargement automatique de Java.
  - title: Sécurité de Niveau Entreprise
    details: Backend natif Rust + Tauri v2, bouclier sandbox anti-traversal & anti-symlink, CSP stricte et chiffrement DPAPI / PBKDF2 + AES-256-GCM.
  - title: Navigateur de Mods Direct
    details: Recherchez et installez vos mods, resource packs et shaders directement depuis Modrinth et CurseForge sans quitter l'interface.
  - title: Multi-Comptes & Mode Hors-Ligne
    details: Authentification officielle Microsoft Device Code et bascule dynamique en mode hors-ligne sans requêtes réseau fantômes.
  - title: Dépôt APT Linux Officiel
    details: Mises à jour automatisées sur Debian et Ubuntu via un dépôt APT officiel signé par clé GPG, avec paquets AppImage, Windows et macOS.
  - title: Cœur Rust & Interface TypeScript Stricte
    details: Backend Rust zéro-warning (~11 Mo, I/O asynchrone Tokio) couplé à un frontend vérifié statiquement à 100 % par TypeScript sans étape de transpilation.
---

<LauncherMockup lang="fr" />

<InstallTabs lang="fr" />

<ScreenshotGrid lang="fr" />

<GensCoreBanner lang="fr" />

<FaqAccordion lang="fr" />
