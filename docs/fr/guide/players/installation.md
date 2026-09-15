# Installation Multi-Plateforme

<div style="display: flex; gap: 8px; margin: 1rem 0; flex-wrap: wrap;">
  <img src="https://img.shields.io/badge/Windows-10%20%2F%2011-blue.svg" alt="Windows" />
  <img src="https://img.shields.io/badge/macOS-Intel%20%26%20Apple%20Silicon-lightgrey.svg" alt="macOS" />
  <img src="https://img.shields.io/badge/Linux-AppImage%20%26%20APT-red.svg" alt="Linux" />
</div>

Gens Launcher est disponible nativement sur **Windows**, **macOS** et **Linux**. Suivez les instructions ci-dessous pour installer l'application sur votre système.

---

## Windows (10 et 11)

### Téléchargement et Installation
1. Rendez-vous sur les [Dernières Releases GitHub](https://github.com/WilliamBossard/Gens-Launcher/releases/latest).
2. Téléchargez le fichier d'installation **`GensLauncher-Setup-X.X.X.exe`**.
3. Double-cliquez sur le fichier téléchargé pour démarrer l'assistant d'installation NSIS.

::: warning Avertissement Windows Defender SmartScreen
Gens Launcher est un projet indépendant open-source. Comme le projet ne possède pas de certificat d'entreprise commercial payant (EV Code Signing, coûtant plusieurs centaines d'euros par an), Windows SmartScreen peut afficher une fenêtre bleue avec le message :  
*« Windows a protégé votre ordinateur »*.

**Pour continuer :**
1. Cliquez sur le lien texte **« Informations complémentaires »** (ou *« More info »*).
2. Cliquez sur le bouton **« Exécuter quand même »** (ou *« Run anyway »*).
3. Le code source étant intégralement public et auditable sur GitHub, le lanceur est 100% sûr.
:::

---

## macOS (Intel et Apple Silicon)

1. Téléchargez l'image disque **`GensLauncher-X.X.X-mac.dmg`** depuis les [Releases GitHub](https://github.com/WilliamBossard/Gens-Launcher/releases/latest).
2. Double-cliquez sur le fichier `.dmg` pour ouvrir le volume d'installation.
3. Glissez-déposez l'icône **Gens Launcher** directement dans le dossier **Applications**.

::: danger Important : Dossier Applications Obligatoire
Vous devez impérativement copier l'application dans le dossier `/Applications`. Si vous exécutez le lanceur directement depuis le volume DMG virtuel, le système de mise à jour automatique (Auto-Updater) ne pourra pas fonctionner correctement.
:::

---

## Linux

Nous mettons à disposition deux formats de distribution pour Linux :

### Option 1 : Dépôt APT Officiel (Recommandé pour Debian et Ubuntu)
Cette méthode est la plus pratique : elle intègre Gens Launcher au gestionnaire de paquets de votre système. Les mises à jour s'effectueront automatiquement avec vos commandes de mise à jour habituelles (`apt upgrade`).

Ouvrez un terminal et exécutez ces 3 étapes :

```bash
# 1. Téléchargez et enregistrez la clé de signature publique GPG officielle
curl -fsSL https://williambossard.github.io/Gens-Launcher/public.key | sudo gpg --dearmor -o /usr/share/keyrings/gens-launcher-keyring.gpg

# 2. Ajoutez le dépôt Gens Launcher à vos sources logicielles
echo "deb [signed-by=/usr/share/keyrings/gens-launcher-keyring.gpg] https://williambossard.github.io/Gens-Launcher/ ./" | sudo tee /etc/apt/sources.list.d/gens-launcher.list

# 3. Mettez à jour vos dépôts et installez Gens Launcher
sudo apt update && sudo apt install gens-launcher
```

Pour mettre à jour le lanceur à l'avenir :
```bash
sudo apt update && sudo apt --only-upgrade install gens-launcher
```

### Option 2 : Paquet Universel AppImage
Le format AppImage fonctionne sur toutes les distributions Linux modernes (Fedora, Arch Linux, Manjaro, Ubuntu, etc.) sans installation préalable :

1. Téléchargez le fichier **`GensLauncher-X.X.X.AppImage`**.
2. Rendez le fichier exécutable :
   - **En ligne de commande :**
     ```bash
     chmod +x GensLauncher-*.AppImage
     ./GensLauncher-*.AppImage
     ```
   - **En interface graphique :** Clic droit sur le fichier -> *Propriétés* -> onglet *Permissions* -> cochez *« Autoriser l'exécution du fichier comme un programme »*.
3. Double-cliquez sur l'AppImage pour jouer !

---

## Configuration Système Requise

| Composant | Recommandation Minimale | Recommandation Optimale |
|---|---|---|
| **Système d'exploitation** | Windows 10 (64-bit), macOS 11+, Linux 64-bit | Windows 11, macOS 14+, Ubuntu 24.04 LTS |
| **Mémoire Vive (RAM)** | 4 Go de RAM système | 8 à 16 Go de RAM système |
| **Stockage Libre** | 2 Go pour le lanceur et Minecraft | 10+ Go (selon la taille de vos modpacks et shaders) |
| **Runtime Java** | Java 8, 17 ou 21 (selon version de Minecraft) | **Géré automatiquement par Gens Launcher** |
