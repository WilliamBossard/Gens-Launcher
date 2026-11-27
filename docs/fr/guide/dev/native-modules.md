# Modules Natifs Rust (Core)

<div style="display: flex; gap: 8px; margin: 1rem 0; flex-wrap: wrap;">
  <img src="https://img.shields.io/badge/Langage-Rust%202024-orange.svg" alt="Rust 2024" />
  <img src="https://img.shields.io/badge/Modules-100%25%20Internes-blue.svg" alt="Modules Internes" />
  <img src="https://img.shields.io/badge/S%C3%A9curit%C3%A9-Surface%20Minimale-green.svg" alt="Sécurité" />
</div>

Pour réduire la taille du binaire (~11 Mo), limiter la chaîne de dépendances et maximiser les performances I/O, Gens-Launcher implémente ses protocoles Minecraft et système en **modules Rust purs** dans `src-tauri/src/`.

---

## 1. Discord Rich Presence Natif (`src-tauri/src/discord.rs`)

Client RPC pur Rust sans crate externe, communiquant directement en IPC OS :

- **Windows :** Named Pipes (`\\.\pipe\discord-ipc-0..9`).
- **Linux / macOS :** Sockets Unix (`$XDG_RUNTIME_DIR/discord-ipc-0..9` ou `/tmp/discord-ipc-0..9`).
- **Protocole & Résilience :** Gère `HANDSHAKE` (0), `FRAME` (1), `CLOSE` (2), `PING` (3) → `PONG` (4), applique la limite de 15 s de Discord et un backoff exponentiel plafonné à 10 tentatives.

---

## 2. Parseur Binaire NBT (`src-tauri/src/nbt.rs`)

Parseur NBT pur Rust utilisant `flate2` (fichiers GZIP comme `level.dat`) et les flux non compressés (`servers.dat`) :

- Supporte les 13 types de tags NBT (`TAG_End` à `TAG_Long_Array`).
- Applique des limites strictes de taille d'entrée (5 Mio), de tableaux, de chaînes et de profondeur d'imbrication pour éviter tout OOM ou dépassement de pile.

---

## 3. Authentification Microsoft OAuth2 & Proxy Mojang (`src-tauri/src/network.rs`)

Implémenté nativement avec `reqwest` (`rustls`, sans dépendance OpenSSL) :

```text
[ Étape 1 ] POST login.live.com/oauth20_connect.srf   -> Device Code & URL de vérification
[ Étape 2 ] POST login.live.com/oauth20_token.srf     -> Jetons OAuth2 access & refresh
[ Étape 3 ] POST user.auth.xboxlive.com/user/authenticate -> Jeton Xbox Live (XBL)
[ Étape 4 ] POST xsts.auth.xboxlive.com/xsts/authorize    -> Jeton XSTS
[ Étape 5 ] POST api.minecraftservices.com/authentication/login_with_xbox -> Jeton MC
[ Étape 6 ] GET  api.minecraftservices.com/minecraft/profile -> UUID, skin & capes
```

- Supporte l'annulation instantanée via `AtomicBool`, le rafraîchissement silencieux des jetons et le proxy Mojang sans restriction CORS.

---

## 4. Server List Ping Natif (`src-tauri/src/ping.rs`)

Interroge les serveurs Minecraft (MOTD, joueurs en ligne, version, favicon) en TCP asynchrone via Tokio :

- **Protection Anti-SSRF :** Bloque les adresses loopback, privées RFC 1918, CGNAT (`100.64.0.0/10`), link-local, multicast et IPv6 mappées IPv4.
- **Framing VarInt :** Plafonne les paquets à 2 Mio et parse IPv4, IPv6 entre crochets et ports personnalisés.
- **Rendu MOTD anti-XSS :** Échappe les entités HTML et convertit les codes `§` en classes CSS sûres.

---

## 5. Moteur de Lancement Minecraft (`src-tauri/src/game.rs`)

Moteur natif Rust prenant en charge **Vanilla, Fabric, Quilt, Forge et NeoForge** :

- **Téléchargements parallèles & intégrité :** Sémaphores Tokio pour téléchargements concurrents avec vérification SHA-1/SHA-256 et retries automatiques.
- **Règles Mojang & Architectures :** Évalue les règles OS/arch (`^x86$`, `arm64`, `darwin`, `linux`, `windows`), gère les versions modernes (`26.x`, `27.x`) et intègre ForgeWrapper.
- **Gestion des runtimes Java :** Scanner JDK/JRE avec cache TTL 5 min et installeur Adoptium Temurin vérifié par SHA-256.
- **Extraction d'archives pure Rust (`src-tauri/src/archive.rs`) :** Extrait `.zip` et `.tar.gz` (USTAR / GNU LongName / PAX) avec protections Zip-Slip, Tar-Slip, anti-symlink et anti-Zip-Bomb.
