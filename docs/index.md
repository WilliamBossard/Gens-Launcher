---
layout: home

hero:
  name: "Gens Launcher"
  text: "Redefining your Minecraft experience."
  tagline: "High-performance, secure open-source Minecraft launcher built with Rust + Tauri v2, Gens-Horizon Delta Sync, and strict TypeScript frontend typing"
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
    details: Native Rust + Tauri v2 backend, lexical & anti-symlink sandbox shield, strict CSP, and DPAPI / PBKDF2 + AES-256-GCM encryption.
  - title: Integrated Content Catalog
    details: Search and install mods, resource packs, and shaders directly from Modrinth and CurseForge in one single click.
  - title: Multi-Account & Smart Offline
    details: Secure Microsoft Device Code authentication and a smart offline fallback system when disconnected from the Internet.
  - title: Native Linux APT Repository
    details: Automatically updated on Debian and Ubuntu via our official signed GPG APT repository, alongside AppImage, Windows .exe, and macOS .dmg.
  - title: Rust Core & Strict TypeScript UI
    details: Zero-warning Rust backend (~11 MB binary, Tokio async I/O) paired with a 100% static type-checked TypeScript frontend with zero build-step overhead.
---

<LauncherMockup />

<InstallTabs />

<ScreenshotGrid />

<GensCoreBanner />

<FaqAccordion />
