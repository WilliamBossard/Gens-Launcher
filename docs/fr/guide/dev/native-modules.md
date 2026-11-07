# Modules Natifs Gens-Core (Zéro Dépendance)

<div style="display: flex; gap: 8px; margin: 1rem 0; flex-wrap: wrap;">
  <img src="https://img.shields.io/badge/D%C3%A9pendances-0%25%20Bloatware-green.svg" alt="Dépendances" />
  <img src="https://img.shields.io/badge/Modules-100%25%20In--House-blue.svg" alt="Modules" />
  <img src="https://img.shields.io/badge/S%C3%A9curit%C3%A9-Surface%20d'Attaque%20Minimale-orange.svg" alt="Sécurité" />
</div>

Afin de réduire drastiquement le poids de l'exécutable, d'accélérer les temps de chargement et de supprimer les vulnérabilités liées à la chaîne d'approvisionnement (*Supply Chain Attacks*), Gens-Launcher bannit les bibliothèques tierces volumineuses au profit de modules **100 % natifs développés en interne** dans `src/gens-core/components/` (tous intégralement vérifiés par TypeScript via `// @ts-check`).

---

## 1. Module Discord Rich Presence Natif (`discord.js`)

Plutôt que d'importer `@xhayper/discord-rpc` ou le SDK Discord officiel (qui pèsent plusieurs mégaoctets et multiplient les dépendances transitives), Gens-Launcher intègre son propre client RPC basé sur les **Named Pipes** du système d'exploitation :

- **Protocole Bas Niveau :**
  - **Windows :** Connexion directe sur `\\?\pipe\discord-ipc-0..9`.
  - **Linux / macOS :** Connexion par socket Unix sur `$XDG_RUNTIME_DIR/discord-ipc-0..9` ou `/tmp/discord-ipc-0..9`.
- **Analyseur de Trame Binaire (IPC Framer) :** Encode les opcodes RPC (`HANDSHAKE = 0`, `FRAME = 1`, `CLOSE = 2`) directement avec des Buffers natifs Node.js.
- **Rate-Limiter Intégré :** Régule les mises à jour de statut sur une fenêtre de 15 secondes conformément aux quotas Discord.
- **Gestion Propre des Déconnexions :** Nettoie immédiatement les timers et sockets lors d'un `disconnect()` et bloque toute reconnexion automatique en mode hors-ligne.

---

## 2. Analyseur et Constructeur Binaire NBT (`nbt.js`)

Le format NBT (*Named Binary Tag*) est le standard binaire utilisé par Minecraft pour stocker les mondes, les inventaires et la liste des serveurs multijoueur (`servers.dat`).

Gens-Launcher remplace `prismarine-nbt` par une implémentation légère basée sur l'API native `node:zlib` :

- **Compression GZIP :** Détection automatique de l'en-tête GZIP ou lecture non compressée.
- **Types Supportés :** `TAG_End` (0), `TAG_Byte` (1), `TAG_Short` (2), `TAG_Int` (3), `TAG_Long` (4), `TAG_Float` (5), `TAG_Double` (6), `TAG_Byte_Array` (7), `TAG_String` (8), `TAG_List` (9), `TAG_Compound` (10), `TAG_Int_Array` (11), `TAG_Long_Array` (12).
- **Entiers 64 bits (`TAG_Long`) :** Manipulation sans perte sous forme de paires 32 bits signées `[hi, lo]`.
- **Édition Sécurisée de `servers.dat` :** Permet à l'interface de lire, réordonner et insérer des serveurs favoris sans jamais corrompre la structure du fichier du joueur.

---

## 3. Authentification Microsoft Native (`auth.js`)

L'authentification officielle Microsoft a été réécrite de zéro sans dépendance OAuth externe :

```text
[ Étape 1 : Device Code ]
POST https://login.live.com/oauth20_connect.srf
  -> Obtention de user_code, device_code et verification_uri

[ Étape 2 : Polling du Jeton OAuth2 ]
POST https://login.live.com/oauth20_token.srf
  -> Échange du device_code contre refresh_token et access_token
  -> Gestion native de authorization_pending, slow_down et des micro-coupures réseau

[ Étape 3 : Authentification Xbox Live (XBL) ]
POST https://user.auth.xboxlive.com/user/authenticate
  -> Obtention du token XBL et du UserHash (uhs)

[ Étape 4 : Autorisation XSTS (Minecraft Services) ]
POST https://xsts.auth.xboxlive.com/xsts/authorize
  -> Obtention du token XSTS

[ Étape 5 : Jeton d'Accès Minecraft ]
POST https://api.minecraftservices.com/authentication/login_with_xbox
  -> Obtention du bearer token Minecraft officiel

[ Étape 6 : Profil Joueur & UUID ]
GET https://api.minecraftservices.com/minecraft/profile
  -> Récupération de l'UUID officiel, du pseudonyme et des skins/capes
```

- **Sécurité :** Tous les flux transitent exclusivement via HTTPS avec validation stricte des certificats TLS.
- **Rafraîchissement Silencieux :** Le `refresh_token` est stocké chiffré et renouvelé automatiquement via `flowRefresh()`.

---

## 4. Ping Serveur Minecraft Natif (`ping.js`)

Interroge l'état en direct des serveurs Minecraft (MOTD, nombre de joueurs connectés, version du protocole et icône base64) directement en TCP :

- **Résolution DNS SRV :** Résout automatiquement les enregistrements `_minecraft._tcp.<host>` avec un délai de repli de 1,5 seconde.
- **Encodage VarInt :** Encode et décode les VarInts et chaînes UTF-8 du protocole Minecraft pour le paquet `0x00` (Handshake + Status Request).
- **Support IPv4 / IPv6 & Ports Personnalisés :** Analyse complète des adresses IPv6 entre crochets et des ports dédiés.

---

## 5. Moteur de Lancement (`launcher.js` & `handler.js`)

Prépare et exécute le processus Java de Minecraft :

- **Vérification Rapide & SHA-1 :** Contrôle la taille et l'empreinte SHA-1 des bibliothèques et assets (`verifyFileFast` & `checkSum`) avec téléchargement parallèle borné (`pMap`).
- **Assemblage du Classpath & Arguments JVM :** Construction dynamique du `-cp` et des arguments JVM (`getJVMArgs`), avec prise en charge des versions modernes de Minecraft (26.x / 27.x et `-XX:StackShadowPages=32`) ainsi que de ForgeWrapper.
- **Extraction Sécurisée :** Utilise `yauzl-promise` avec vérification stricte des chemins de sortie pour empêcher toute attaque Zip Slip.
