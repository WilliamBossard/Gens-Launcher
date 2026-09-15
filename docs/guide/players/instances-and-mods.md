# Instances and Mod Catalog

<div style="display: flex; gap: 8px; margin: 1rem 0; flex-wrap: wrap;">
  <img src="https://img.shields.io/badge/Modloaders-Fabric%20%7C%20Forge%20%7C%20Quilt%20%7C%20NeoForge-blue.svg" alt="Modloaders" />
  <img src="https://img.shields.io/badge/Catalogs-Modrinth%20%26%20CurseForge-green.svg" alt="Catalogs" />
</div>

Gens Launcher offers fully isolated game profile management ("Instances"), drawing inspiration from leading tools like MultiMC and Prism Launcher, while integrating direct access to popular online mod catalogs.

---

## Creating an Instance

1. In the top navigation bar, click **New Instance**.
2. Configure basic properties:
   - **Instance Name:** Provide a descriptive name (e.g., *Survival 1.21 Fabric*).
   - **Minecraft Version:** Pick from all official releases, development snapshots, and historical builds.
   - **Modloader Engine:** Choose your desired runtime:
     - **Vanilla:** Pure unmodified game files.
     - **Fabric:** Modern, lightweight modloader, ideal for performance enhancements (Sodium, Lithium, Iris).
     - **Forge:** The classic modloader for extensive tech and magic modpacks.
     - **Quilt:** A modern fork compatible with the vast majority of Fabric mods.
     - **NeoForge:** The modern evolution of Forge for Minecraft 1.20.2 and above.
3. Click **Create**. Gens Launcher retrieves official manifests and generates an isolated directory in `%AppData%\GensLauncher\instances\<Name>`.

---

## Configuring Java and Memory Allocation (RAM)

Every profile can specify its dedicated RAM allocation and Java runtime environment:

1. Right-click your instance -> **Instance Settings** (or select it and click the gear icon).
2. **RAM Allocation:**
   - **Vanilla recommendation:** 2 GB (`2048 MB`).
   - **Light modpacks:** 4 GB (`4096 MB`).
   - **Heavy modpacks (200+ mods):** 6 to 8 GB (`6144` to `8192 MB`).
3. **Automatic Java Detection:**
   Gens Launcher inspects your machine to find the appropriate Java version matching your target Minecraft edition:
   - **Minecraft 1.16 and older:** Java 8
   - **Minecraft 1.17:** Java 16
   - **Minecraft 1.18 to 1.20.4:** Java 17
   - **Minecraft 1.20.5 and newer:** Java 21 or Java 25
   If the required version is missing from your system, Gens Launcher offers automated one-click installation.

---

## Integrated Mod and Content Browser

No more browsing obscure websites to download unverified `.jar` files:

1. Open your instance and switch to the **Mods** or **Content** tab.
2. Click **Add Content**.
3. Use the integrated search bar connected directly to **Modrinth** and **CurseForge** APIs.
4. Filter by category, game version, and modloader.
5. Click **Install**:
   - The compatible `.jar` is downloaded straight into the instance's `mods/` directory.
   - Essential dependencies are identified automatically.
6. Easily toggle mods on or off using simple switches without deleting their underlying files.

---

## Shaders and Resource Packs

The catalog browser also supports additional cosmetic content:
- **Shader Packs:** Search and apply shaders (Complementary, BSL, Iris Shaders) in one click.
- **Resource Packs:** Download high-resolution textures, custom audio packs, and fonts directly into `resourcepacks/`.

---

## Importing and Exporting Instances

- **Export:** Export any instance to a portable `.zip` archive ready to share with friends or store as an offline backup.
- **Import:** Click **Import Instance** to load standard archive formats (CurseForge modpacks, Modrinth modpacks, or MultiMC zip files).
