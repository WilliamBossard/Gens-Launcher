# Native Gens-Core Modules (Zero Dependencies)

<div style="display: flex; gap: 8px; margin: 1rem 0; flex-wrap: wrap;">
  <img src="https://img.shields.io/badge/Dependencies-0%25%20Bloatware-green.svg" alt="Dependencies" />
  <img src="https://img.shields.io/badge/Modules-100%25%20In--House-blue.svg" alt="Modules" />
  <img src="https://img.shields.io/badge/Security-Minimal%20Attack%20Surface-orange.svg" alt="Security" />
</div>

To drastically minimize package size, accelerate cold boot times, and eliminate vulnerabilities arising from dependency supply chains, Gens-Launcher avoids heavy third-party npm packages in favor of **100% native in-house modules**.

---

## 1. Native Discord Rich Presence (`discord.js`)

Rather than relying on `@xhayper/discord-rpc` or the official Discord GameSDK (which introduce heavy binary bloat and multiple sub-dependencies), Gens-Launcher implements its own RPC client using operating system **Named Pipes**:

- **Low-Level Protocol:**
  - **Windows:** Direct stream connection to `\\?\pipe\discord-ipc-0`.
  - **Linux / macOS:** Unix domain socket connection to `$XDG_RUNTIME_DIR/discord-ipc-0` or `/tmp/discord-ipc-0`.
- **Binary Frame Parser:** Handcrafted encoder and decoder for Discord IPC opcodes (`HANDSHAKE = 0`, `FRAME = 1`, `CLOSE = 2`, `PING = 3`, `PONG = 4`) leveraging Node.js Buffers.
- **Integrated Rate Limiter:** Protects against rate limits on presence updates.
- **Smart Offline Management:** When running without an active network connection, `discord.js` reads `settings.json` locally and defuses recurring connection retries to prevent zombie sockets.

---

## 2. Binary NBT Parser and Builder (`nbt.js`)

The Named Binary Tag (NBT) format is the standard binary serialization used by Minecraft for world saves, entity data, and player server lists (`servers.dat`).

Gens-Launcher replaces `prismarine-nbt` with a lightweight, native implementation built upon `node:zlib`:
- **Compression Support:** Automatic GZIP/ZLIB decompression header detection and uncompressed stream processing.
- **Full Tag Specification:** TAG_End (0), TAG_Byte (1), TAG_Short (2), TAG_Int (3), TAG_Long (4), TAG_Float (5), TAG_Double (6), TAG_Byte_Array (7), TAG_String (8), TAG_List (9), TAG_Compound (10), TAG_Int_Array (11), TAG_Long_Array (12).
- **Native BigInt Support:** Preserves 64-bit integer precision for world seeds and epoch timestamps.
- **Safe Server List Operations:** Enables the launcher UI to reorder and add multiplayer servers directly into `servers.dat` without risking file corruption.

---

## 3. In-House Microsoft Authentication Flow (`auth.js`)

The Microsoft and Xbox Live login chain is implemented from scratch:

```
[ Step 1: Device Code Acquisition ]
POST https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode
  -> Returns user_code and verification_uri

[ Step 2: OAuth2 Token Polling ]
POST https://login.microsoftonline.com/consumers/oauth2/v2.0/token
  -> Exchanges device code for refresh_token and access_token

[ Step 3: Xbox Live (XBL) Authentication ]
POST https://user.auth.xboxlive.com/user/authenticate
  -> Exchanges access_token for XBL token and UserHash

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
- **Silent Background Refresh:** Stored encrypted refresh tokens automatically refresh expired bearer tokens without interrupting gameplay.

---

## 4. Minecraft Launch Engine (`src/gens-core/components/launcher.js`)

Handles preparation and execution of the Minecraft Java process:
- **Checksum Verification:** Every jar library and asset index file is validated against its official SHA-1 hash.
- **Classpath Assembly:** Dynamically constructs the `-cp` argument using OS-specific path separators (`;` on Windows, `:` on Unix).
- **Native Extraction:** Extracts platform-specific `.dll`, `.so`, or `.dylib` archives into an isolated temporary folder purged upon termination.
- **Safe Process Invocation:** Uses `child_process.execFile` instead of `child_process.exec`, preventing shell injection vulnerabilities.
