# Modules Natifs Gens-Core (Zéro Dépendance)

<div style="display: flex; gap: 8px; margin: 1rem 0; flex-wrap: wrap;">
  <img src="https://img.shields.io/badge/D%C3%A9pendances-0%25%20Bloatware-green.svg" alt="Dépendances" />
  <img src="https://img.shields.io/badge/Modules-100%25%20In--House-blue.svg" alt="Modules" />
  <img src="https://img.shields.io/badge/S%C3%A9curit%C3%A9-Surface%20d'Attaque%20Minimale-orange.svg" alt="Sécurité" />
</div>

Afin de réduire drastiquement le poids de l'exécutable, d'accélérer les temps de chargement et de supprimer les vulnérabilités liées à la chaîne d'approvisionnement (*Supply Chain Attacks*), Gens-Launcher bannit les bibliothèques tierces volumineuses au profit de modules **100% natifs développés en interne**.

---

## 1. Module Discord Rich Presence Natif (`discord.js`)

Plutôt que d'importer `@xhayper/discord-rpc` ou le SDK Discord officiel (qui pèsent plusieurs mégaoctets et multiplient les dépendances transitives), Gens-Launcher intègre son propre client RPC basé sur les **Named Pipes** du système d'exploitation :

- **Protocole Bas Niveau :**
  - **Windows :** Connexion directe sur `\\?\pipe\discord-ipc-0`.
  - **Linux / macOS :** Connexion par socket Unix sur `$XDG_RUNTIME_DIR/discord-ipc-0` ou `/tmp/discord-ipc-0`.
- **Analyseur de Trame Binaire (IPC Framer) :** Encode et décode les opcodes RPC (`HANDSHAKE = 0`, `FRAME = 1`, `CLOSE = 2`, `PING = 3`, `PONG = 4`) directement avec des Buffers natifs Node.js.
- **Rate-Limiter Intégré :** Empêche tout dépassement des quotas d'événements de l'API Discord.
- **Gestion Stricte du Mode Hors-Ligne :** Lorsque l'application démarre sans connexion Internet, `discord.js` consulte localement `settings.json` et coupe toute tentative de socket en boucle pour éviter la création de processus zombies.

---

## 2. Analyseur et Constructeur Binaire NBT (`nbt.js`)

Le format NBT (*Named Binary Tag*) est le standard binaire utilisé par Minecraft pour stocker les mondes, les inventaires et la liste des serveurs multijoueur (`servers.dat`).

Gens-Launcher remplace `prismarine-nbt` par une implémentation légère basée sur l'API native `node:zlib` :
- **Compression GZIP / ZLIB :** Détection automatique de l'en-tête de compression ou lecture non compressée.
- **Types Supportés :** TAG_End (0), TAG_Byte (1), TAG_Short (2), TAG_Int (3), TAG_Long (4), TAG_Float (5), TAG_Double (6), TAG_Byte_Array (7), TAG_String (8), TAG_List (9), TAG_Compound (10), TAG_Int_Array (11), TAG_Long_Array (12).
- **Prise en charge des BigInt :** Manipulation sans perte des entiers 64 bits (`TAG_Long`).
- **Édition Sécurisée de `servers.dat` :** Permet à l'interface de lire, réordonner et insérer des serveurs favoris sans jamais corrompre la structure du fichier du joueur.

---

## 3. Authentification Microsoft Native (`auth.js`)

L'authentification officielle Microsoft a été réécrite de zéro pour se dispenser de bibliothèques tierces :

```
[ Étape 1 : Device Code ]
POST https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode
  -> Obtention de user_code et verification_uri

[ Étape 2 : Polling du Jeton OAuth2 ]
POST https://login.microsoftonline.com/consumers/oauth2/v2.0/token
  -> Obtention du refresh_token et access_token

[ Étape 3 : Authentification Xbox Live (XBL) ]
POST https://user.auth.xboxlive.com/user/authenticate
  -> Obtention du token XBL et du UserHash

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
- **Rafraîchissement Silencieux :** Le `refresh_token` est stocké chiffré et renouvelé en arrière-plan sans interrompre l'expérience de jeu.

---

## 4. Moteur de Lancement (`src/gens-core/components/launcher.js`)

Le lanceur prépare et exécute le processus Java de Minecraft :
- **Vérification d'Intégrité :** Chaque bibliothèque (.jar) et asset est comparé à son empreinte SHA-1 officielle avant exécution.
- **Assemblage du Classpath :** Construction dynamique du paramètre `-cp` avec séparateur natif (`;` sous Windows, `:` sous Linux/macOS).
- **Extraction des Bibliothèques Natives :** Extraction des fichiers `.dll`, `.so` ou `.dylib` dans un dossier temporaire isolé nettoyé à la fermeture.
- **Exécution Sécurisée :** Utilisation stricte de `child_process.execFile` (et non `exec`), garantissant l'impossibilité d'injecter des commandes shell arbitraires via les arguments JVM ou les noms d'instance.
