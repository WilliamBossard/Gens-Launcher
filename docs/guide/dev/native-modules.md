# Native Rust Core Modules

<div style="display: flex; gap: 8px; margin: 1rem 0; flex-wrap: wrap;">
  <img src="https://img.shields.io/badge/Language-Rust%202024-orange.svg" alt="Rust 2024" />
  <img src="https://img.shields.io/badge/Modules-100%25%20In--House-blue.svg" alt="Modules" />
  <img src="https://img.shields.io/badge/Security-Minimal%20Attack%20Surface-green.svg" alt="Security" />
</div>

To minimize binary size (~11 MB), eliminate bloated dependency chains, and maximize I/O performance, Gens-Launcher implements its core Minecraft and system protocols as **pure-Rust in-house modules** inside `src-tauri/src/`.

---

## 1. Native Discord Rich Presence (`src-tauri/src/discord.rs`)

Zero-crate pure-Rust RPC client communicating directly over OS IPC:

- **Windows:** Named Pipes (`\\.\pipe\discord-ipc-0..9`).
- **Linux / macOS:** Unix domain sockets (`$XDG_RUNTIME_DIR/discord-ipc-0..9` or `/tmp/discord-ipc-0..9`).
- **Protocol & Resilience:** Handles `HANDSHAKE` (0), `FRAME` (1), `CLOSE` (2), `PING` (3) → `PONG` (4), enforces Discord's 15-second rate limit, and applies exponential backoff capped at 10 reconnect attempts.

---

## 2. Binary NBT Parser (`src-tauri/src/nbt.rs`)

Pure-Rust Named Binary Tag (NBT) parser built on `flate2` (for GZIP-compressed files like `level.dat`) and raw uncompressed streams (`servers.dat`):

- Supports all 13 NBT tag types (`TAG_End` through `TAG_Long_Array`).
- Enforces strict input size (5 MiB), array bounds, string length, and nesting depth limits to prevent OOM or stack-overflow attacks from malformed world files.

---

## 3. Microsoft OAuth2 & Mojang Proxy (`src-tauri/src/network.rs`)

Implemented natively over `reqwest` (`rustls`, zero OpenSSL dependency):

```text
[ Step 1 ] POST login.live.com/oauth20_connect.srf   -> Device Code & verification URI
[ Step 2 ] POST login.live.com/oauth20_token.srf     -> OAuth2 access & refresh tokens
[ Step 3 ] POST user.auth.xboxlive.com/user/authenticate -> Xbox Live (XBL) token
[ Step 4 ] POST xsts.auth.xboxlive.com/xsts/authorize    -> XSTS token
[ Step 5 ] POST api.minecraftservices.com/authentication/login_with_xbox -> MC token
[ Step 6 ] GET  api.minecraftservices.com/minecraft/profile -> UUID, skin & capes
```

- Supports cancellation via `AtomicBool`, silent background token refresh, and CORS-free Mojang skin/profile proxying.

---

## 4. Native Server List Ping (`src-tauri/src/ping.rs`)

Queries live Minecraft server status (MOTD, player count, protocol version, favicon) directly over Tokio TCP:

- **Anti-SSRF Protection:** Blocks loopback, private RFC 1918, CGNAT (`100.64.0.0/10`), link-local, multicast, and IPv4-mapped IPv6 targets.
- **VarInt Framing:** Caps packet size at 2 MiB and parses IPv4, bracketed IPv6, and custom ports.
- **XSS-Safe MOTD Renderer:** Escapes HTML entities and converts legacy `§` formatting codes into safe CSS classes.

---

## 5. Native Minecraft Launch Engine (`src-tauri/src/game.rs`)

Full native Rust launcher supporting **Vanilla, Fabric, Quilt, Forge, and NeoForge**:

- **Concurrent Downloads & Verification:** Uses Tokio semaphores for bounded parallel downloads with SHA-1/SHA-256 verification and automatic retries.
- **Mojang Rules & Architecture Filtering:** Evaluates OS/arch rules (`^x86$`, `arm64`, `darwin`, `linux`, `windows`), handles modern Minecraft versions (`26.x`, `27.x`), and integrates ForgeWrapper.
- **Java Runtime Management:** Scans system JDK/JREs (with 5-minute TTL cache) and installs SHA-256 verified Adoptium Temurin runtimes natively.
- **Pure-Rust Archive Extraction (`src-tauri/src/archive.rs`):** Extracts `.zip` and USTAR / GNU LongName / PAX `.tar.gz` archives with Zip-Slip, Tar-Slip, symlink, and Zip-Bomb protection.
