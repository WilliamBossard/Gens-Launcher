---
layout: home

hero:
  name: "Gens Launcher"
  text: "Redefining your Minecraft experience."
  tagline: "High-performance, secure open-source launcher powered by Gens-Horizon Delta Sync technology"
  image:
    src: /icon.png
    alt: Gens Launcher Logo
  actions:
    - theme: brand
      text: Download Now
      link: /#install
    - theme: alt
      text: Player Guide
      link: /guide/players/getting-started
    - theme: alt
      text: Developer Docs
      link: /guide/dev/architecture
    - theme: alt
      text: GitHub Repository
      link: https://github.com/WilliamBossard/Gens-Launcher

features:
  - title: Horizon Delta Sync
    details: Headless cloud synchronization engine that uploads and downloads only modified bytes, drastically saving bandwidth and storage.
  - title: Multi-Modloader Support
    details: Seamlessly configure and launch Vanilla, Fabric, Forge, Quilt, and NeoForge instances with automated Java runtime detection.
  - title: Enterprise-Grade Security
    details: Strict Electron context isolation, sandboxed preload traversal shield, dual-layer CSP, and hardware-bound AES-256-GCM encryption.
  - title: Integrated Content Catalog
    details: Search and install mods, resource packs, and shaders directly from Modrinth and CurseForge in one single click.
  - title: Multi-Account & Smart Offline
    details: Secure Microsoft Device Code authentication and a smart offline fallback system when disconnected from the Internet.
  - title: Native Linux APT Repository
    details: Automatically updated on Debian and Ubuntu via our official signed GPG APT repository, alongside AppImage, Windows .exe, and macOS .dmg.
---

<LauncherMockup />

<InstallTabs />

<ScreenshotGrid />

<GensCoreBanner />

<FaqAccordion />
