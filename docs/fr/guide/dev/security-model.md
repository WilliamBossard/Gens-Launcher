# Modèle de Sécurité et Sandboxing

<div style="display: flex; gap: 8px; margin: 1rem 0; flex-wrap: wrap;">
  <img src="https://img.shields.io/badge/Principe-D%C3%A9fense%20en%20Profondeur-blue.svg" alt="Défense en Profondeur" />
  <img src="https://img.shields.io/badge/Chiffrement-DPAPI%20%2B%20AES--256--GCM-red.svg" alt="Chiffrement" />
  <img src="https://img.shields.io/badge/CSP-Stricte%20Tauri%20v2-green.svg" alt="CSP" />
</div>

La conception de Gens-Launcher repose sur le principe de **Défense en Profondeur**. Plusieurs barrières indépendantes dans le backend Rust (`src-tauri/src/`) et Tauri v2 protègent la machine hôte, même face à une ressource distante ou un mod tiers malveillant.

---

## 1. Isolation WebView Native et Exposition Scellée

- **Aucun runtime Node.js dans l'UI :** Le frontend s'exécute dans la WebView native du système sans accès direct au système de fichiers, aux variables d'environnement ni au shell.
- **Liste blanche IPC statique (`frontend/src/tauri-bridge.js`) :** Seuls les canaux déclarés dans `VALID_SEND_CHANNELS`, `VALID_INVOKE_CHANNELS` et `VALID_RECEIVE_CHANNELS` peuvent être invoqués.
- **Protocole `asset://` confiné (`tauri.conf.json`) :** L'accès aux fichiers locaux via `asset://` est strictement limité à `$APPDATA/GensLauncher/**`.

---

## 2. Bouclier Sandbox Rust (Anti-Traversal & Anti-Symlink)

Chaque opération disque ou archive est validée dans `src-tauri/src/sandbox.rs` :

- **Double validation lexicale + canonique :** Les chemins sont normalisés lexicalement puis résolus via `realpath` afin de bloquer les traversées `..`, liens symboliques, jonctions Windows et partages réseau UNC (`\\serveur\partage`).
- **Confinement en écriture :** Toute écriture disque est strictement confinée à `$APPDATA/GensLauncher`.
- **Denylist Renderer :** Les fichiers sensibles (`.secret_key`, `.key_salt`, `horizon_seal.key`, `trusted_external_domains.json`, `github_release_cache.json`) et les répertoires critiques (`horizon`, `bin`, `java`, `runtime`, `msa-cache`) sont protégés contre la modification ou suppression par l'interface.
- **Protection Zip-Slip & Tar-Slip (`archive.rs`) :** Chaque entrée d'archive est contrôlée contre `dst`, les symlinks Unix (`0o120000`) et hardlinks sont rejetés, et la taille décompressée totale est plafonnée à 4 Gio (anti-Zip-Bomb).

---

## 3. Content Security Policy (CSP) Stricte

Appliquée globalement par Tauri v2 dans `src-tauri/tauri.conf.json` :

- `script-src 'self'` et `style-src 'self'` (zéro `unsafe-inline` ou `unsafe-eval`).
- `object-src 'none'`, `frame-src 'none'`, `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'none'`.
- Listes blanches HTTPS explicites pour `img-src` et `connect-src` (Modrinth, CurseForge, Mojang, Fabric, Quilt, Forge, NeoForge, Adoptium, GitHub).

---

## 4. Cryptographie et Migration depuis Electron (`crypto.rs`)

La persistance des jetons suit les recommandations NIST et OWASP :

```text
[ Windows ] -> CryptProtectData (DPAPI) -> safeStorage:<hex>
               (déchiffre aussi l'ancien format Chromium/Electron Local State os_crypt v10/v11)

[ Fallback / Multi-OS ]
   .secret_key + sel aléatoire 16 octets (.key_salt)
                     |
                     v
       +--------------------------+
       |  PBKDF2-HMAC-SHA256      |
       |  600 000 itérations      |
       +--------------------------+
                     |
                     v
            [ Clé 256 bits ]
                     |
                     v
       +--------------------------+
       |  AES-256-GCM (nonce 12o) |
       +--------------------------+
                     |
                     v
   aes-gcm:<iv>:<tag>:<ciphertext>
```

- **Migration Windows transparente :** Les utilisateurs venant d'Electron sous Windows conservent automatiquement leurs sessions Microsoft via `read_chromium_os_crypt_key()` + DPAPI.
- **Mode GCM authentifié :** Le tag d'authentification 16 octets rejette toute altération du fichier chiffré.

---

## 5. Durcissement JVM, Téléchargements et Imports

- **Garde arguments JVM & lancement (`game_validation.rs`) :** Bloque les options JVM dangereuses (`-javaagent`, `-agentlib`, `-XX:OnOutOfMemoryError`, `--add-opens`, `-Djava.security.policy`, etc.) ainsi que les flags Minecraft sensibles (`--accessToken`, `--proxyHost`).
- **Listes blanches HTTPS :** Tous les téléchargements imposent `https:` et des domaines autorisés ; les hôtes multi-locataires (`github.com`, `gitlab.com`) exigent une vérification de hash.
- **Vérification binaire Magic Bytes (`network.rs`) :** Les images et archives importées sont validées à la fois par extension et par signature binaire (`PNG`, `JPEG`, `GIF`, `WEBP`, `BMP`, `ICO`, `ZIP`) avant d'entrer dans le sandbox.
