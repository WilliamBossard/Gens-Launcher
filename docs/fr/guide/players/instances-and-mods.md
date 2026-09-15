# Instances et Catalogue de Mods

<div style="display: flex; gap: 8px; margin: 1rem 0; flex-wrap: wrap;">
  <img src="https://img.shields.io/badge/Modloaders-Fabric%20%7C%20Forge%20%7C%20Quilt%20%7C%20NeoForge-blue.svg" alt="Modloaders" />
  <img src="https://img.shields.io/badge/Catalogues-Modrinth%20%26%20CurseForge-green.svg" alt="Catalogues" />
</div>

Gens Launcher propose une gestion complète et isolée de vos profils de jeu (« Instances »), inspirée des meilleurs outils du marché comme MultiMC et Prism Launcher, avec un accès direct aux catalogues de mods en ligne.

---

## Créer une Instance

1. Dans le bandeau supérieur de l'application, cliquez sur **Nouvelle Instance**.
2. Renseignez les paramètres de base :
   - **Nom de l'instance :** Donnez un libellé clair (ex: *Survie 1.21 Fabric*).
   - **Version de Minecraft :** Choisissez parmi toutes les versions disponibles (releases officielles, snapshots, versions historiques).
   - **Modloader :** Sélectionnez le moteur de votre choix :
     - **Vanilla :** Aucun mod, jeu officiel pur.
     - **Fabric :** Léger, moderne, idéal pour les mods d'optimisation (Sodium, Lithium, Iris).
     - **Forge :** Le modloader historique pour les gros modpacks techniques et magiques.
     - **Quilt :** Fork moderne compatible avec la majorité des mods Fabric.
     - **NeoForge :** La nouvelle génération de Forge pour les versions 1.20.2 et supérieures.
3. Cliquez sur **Créer**. Gens Launcher télécharge les métadonnées officielles et prépare l'arborescence isolée dans `%AppData%\GensLauncher\instances\<Nom>`.

---

## Configuration de Java et Mémoire Vive (RAM)

Chaque instance peut posséder sa propre allocation de mémoire et sa propre machine virtuelle Java :

1. Faites un clic droit sur l'instance -> **Paramètres de l'Instance** (ou sélectionnez-la et cliquez sur l'engrenage).
2. **Allocation RAM :**
   - **Minimum conseillé (Vanilla) :** 2 Go (`2048 Mo`).
   - **Conseillé pour Modpacks légers :** 4 Go (`4096 Mo`).
   - **Modpacks lourds (200+ mods) :** 6 à 8 Go (`6144` à `8192 Mo`).
3. **Détection automatique de Java :**
   Gens Launcher analyse automatiquement vos dossiers système et sélectionne la bonne version de Java requise pour votre version du jeu :
   - **Minecraft 1.16 et antérieur :** Java 8
   - **Minecraft 1.17 :** Java 16
   - **Minecraft 1.18 à 1.20.4 :** Java 17
   - **Minecraft 1.20.5 et supérieur :** Java 21 ou Java 25
   Si la version appropriée est absente de votre ordinateur, Gens Launcher vous propose de la télécharger automatiquement.

---

## Catalogue de Mods et Contenu Intégré

Fini le temps où vous deviez ouvrir votre navigateur pour chercher des fichiers `.jar` suspects :

1. Ouvrez l'instance souhaitée et cliquez sur l'onglet **Mods** (ou **Ressources**).
2. Cliquez sur le bouton **Ajouter du Contenu**.
3. Utilisez la barre de recherche connectée en temps réel aux API de **Modrinth** et **CurseForge**.
4. Filtrez par catégorie, version du jeu et modloader.
5. Cliquez sur **Installer** :
   - Le fichier `.jar` compatible est automatiquement téléchargé et déposé dans le dossier `mods/`.
   - Les dépendances nécessaires sont identifiées.
6. Vous pouvez également activer ou désactiver un mod d'un simple interrupteur sans supprimer le fichier.

---

## Shaders et Packs de Textures

Le même système de catalogue intégré est disponible pour :
- **Les Shaders Packs :** Recherchez des shaders populaires (Complementary, BSL, Iris Shaders) et activez-les en un clic.
- **Les Resource Packs :** Téléchargez des textures haute résolution, packs sonores ou polices d'écriture directement dans le sous-dossier `resourcepacks/`.

---

## Import et Export d'Instances

- **Exporter :** Vous pouvez exporter votre instance sous forme d'archive `.zip` prête à être partagée avec vos amis ou sauvegardée localement.
- **Importer :** Cliquez sur **Importer une Instance** pour charger une archive zip compatible (format CurseForge, Modrinth Modpack ou MultiMC zip).
