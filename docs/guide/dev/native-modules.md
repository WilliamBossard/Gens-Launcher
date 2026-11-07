# Native Gens-Core Modules (Zero Dependencies)

<div style="display: flex; gap: 8px; margin: 1rem 0; flex-wrap: wrap;">
  <img src="https://img.shields.io/badge/Dependencies-0%25%20Bloatware-green.svg" alt="Dependencies" />
  <img src="https://img.shields.io/badge/Modules-100%25%20In--House-blue.svg" alt="Modules" />
  <img src="https://img.shields.io/badge/Security-Minimal%20Attack%20Surface-orange.svg" alt="Security" />
</div>

To drastically minimize package size, accelerate cold boot times, and eliminate vulnerabilities arising from dependency supply chains, Gens-Launcher avoids heavy third-party npm packages in favor of **100% native in-house modules** located in `src/gens-core/components/` (all strictly type-checked via `// @ts-check`).

---

## 1. Native Discord Rich Presence (`discord.js`)

Rather than relying on `@xhayper/discord-rpc` or the official Discord GameSDK (which introduce heavy binary bloat and multiple sub-dependencies), Gens-Launcher implements its own RPC client using operating system **Named Pipes**:

- **Low-Level Protocol:**
  - **Windows:** Direct stream connection to `\\?\pipe\discord-ipc-0..9`.
  - **Linux / macOS:** Unix domain socket connection to `$XDG_RUNTIME_DIR/discord-ipc-0..9` or `/tmp/discord-ipc-0..9`.
- **Binary Frame Parser:** Handcrafted encoder and decoder for Discord IPC opcodes (`HANDSHAKE = 0`, `FRAME = 1`, `CLOSE = 2`) leveraging Node.js Buffers.
- **Integrated Rate Limiter:** Throttles presence updates to a 15-second window to respect Discord IPC rate limits.
- **Smart Offline & Disconnect Management:** Cleanly tears down timers and sockets on `disconnect()` and blocks background reconnect loops when running in Offline Mode.

---

## 2. Binary NBT Parser and Builder (`nbt.js`)

The Named Binary Tag (NBT) format is the standard binary serialization used by Minecraft for world saves, entity data, and player server lists (`servers.dat`).

Gens-Launcher replaces `prismarine-nbt` with a lightweight, native implementation built upon `node:zlib`:

- **Compression Support:** Automatic GZIP decompression detection and uncompressed stream processing.
- **Full Tag Specification:** `TAG_End` (0), `TAG_Byte` (1), `TAG_Short` (2), `TAG_Int` (3), `TAG_Long` (4), `TAG_Float` (5), `TAG_Double` (6), `TAG_Byte_Array` (7), `TAG_String` (8), `TAG_List` (9), `TAG_Compound` (10), `TAG_Int_Array` (11), `TAG_Long_Array` (12).
- **64-Bit Long Compatibility:** Preserves 64-bit integer precision as `[hi, lo]` signed 32-bit pairs.
- **Safe Server List Operations:** Enables the launcher UI to read, reorder, and add multiplayer servers directly into `servers.dat` without risking file corruption.

---

## 3. In-House Microsoft Authentication Flow (`auth.js`)

The Microsoft and Xbox Live login chain is implemented from scratch without external OAuth libraries:

```text
[ Step 1: Device Code Acquisition ]
POST https://login.live.com/oauth20_connect.srf
  -> Returns user_code, device_code, and verification_uri

[ Step 2: OAuth2 Token Polling ]
POST https://login.live.com/oauth20_token.srf
  -> Exchanges device_code for refresh_token and access_token
  -> Handles authorization_pending, slow_down, and transient network retries

[ Step 3: Xbox Live (XBL) Authentication ]
POST https://user.auth.xboxlive.com/user/authenticate
  -> Exchanges access_token for XBL token and UserHash (uhs)

[ Step 4: XSTS Authorization (Minecraft Scope) ]
POST https://xsts.auth.xboxlive.com/xsts/authorize
  -> Exchanges XBL token for XSTS token

[ Step 5: Minecraft Access Token ]
POST https://api.minecraftservices.com/authentication/login_with_xbox
  -> Yields official Minecraft bearer token

[ Step 6: Player Profile & UUID ]
GET https://api.minecraftservices.com/minecraft/profile
  -> Retrieves player UUID, username, skin textures, and capes
```

- **TLS Security:** All communication strictly enforces HTTPS with standard certificate authority verification.
- **Silent Background Refresh:** Stored encrypted refresh tokens automatically refresh expired bearer tokens via `flowRefresh()`.

---

## 4. Native Server List Ping (`ping.js`)

Queries live Minecraft server status (MOTD, online player count, protocol version, and base64 favicon) directly over TCP:

- **DNS SRV Resolution:** Automatically resolves `_minecraft._tcp.<host>` records with a 1.5s fallback timeout.
- **VarInt Framing:** Encodes and decodes Minecraft protocol VarInts and UTF-8 strings for packet `0x00` (Handshake + Status Request).
- **IPv4 / IPv6 & Custom Port Parsing:** Supports bracketed IPv6 addresses and custom port overrides.

---

## 5. Minecraft Launch Engine (`launcher.js` & `handler.js`)

Handles preparation and execution of the Minecraft Java process:

- **Fast Verification & Checksum Validation:** Validates library sizes and SHA-1 hashes (`verifyFileFast` & `checkSum`) with bounded concurrency (`pMap`).
- **Classpath & JVM Argument Assembly:** Dynamically constructs `-cp` and JVM arguments (`getJVMArgs`), supporting modern Minecraft versions (including 26.x / 27.x and `-XX:StackShadowPages=32`) and ForgeWrapper integration.
- **Safe Archive Extraction:** Uses `yauzl-promise` with strict path boundary checks to extract natives and client packages without Zip Slip risks.
