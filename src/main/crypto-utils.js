const { app, safeStorage } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

let _cachedMainSecretKey = null;
let _cachedLegacyKey = null; // Ancienne clé SHA-256 simple — pour migration des données existantes

const PBKDF2_SALT_FILE = path.join(app.getPath('appData'), 'GensLauncher', '.key_salt');
const PBKDF2_ITERATIONS = 100000;

// Promise mémorisée : PBKDF2 ne s'exécute qu'une seule fois, de façon asynchrone
// (thread pool Node.js — ne bloque pas le Main Process Electron)
let _mainKeyPromise = null;

function _getMainProcSecretKey() {
    if (_mainKeyPromise) return _mainKeyPromise;

    _mainKeyPromise = new Promise(async (resolve, reject) => {
        // 1. Lire ou générer le secret applicatif
        const secretPath = path.join(app.getPath('appData'), 'GensLauncher', '.secret_key');
        let secret;
        try {
            if (await fs.promises.access(secretPath).then(()=>true).catch(()=>false)) {
                secret = await fs.promises.readFile(secretPath, 'utf8');
            } else {
                secret = crypto.randomUUID();
                await fs.promises.mkdir(path.dirname(secretPath), { recursive: true });
                await fs.promises.writeFile(secretPath, secret, { encoding: 'utf8', mode: 0o600 });
            }
        } catch (e) {
            secret = os.hostname() + '_' + (os.userInfo().username || 'user');
        }

        // 2. Générer/lire le salt dédié pour PBKDF2
        let salt;
        try {
            if (await fs.promises.access(PBKDF2_SALT_FILE).then(()=>true).catch(()=>false)) {
                salt = await fs.promises.readFile(PBKDF2_SALT_FILE);
            } else {
                salt = crypto.randomBytes(16);
                await fs.promises.writeFile(PBKDF2_SALT_FILE, salt, { encoding: 'binary', mode: 0o600 });
            }
        } catch (saltErr) {
            // Si le FS est inaccessible, on ne peut pas chiffrer de façon sécurisée.
            // Mieux vaut échouer tôt que silencieusement utiliser un salt prévisible.
            return reject(new Error(
                `[crypto-utils] Impossible de lire/créer le salt PBKDF2 (${saltErr.message}). ` +
                `Vérifiez les permissions sur %AppData%/GensLauncher/.`
            ));
        }

        // 3. Dérivation asynchrone via thread pool — ne bloque pas l'event loop
        crypto.pbkdf2(secret, salt, PBKDF2_ITERATIONS, 32, 'sha256', (err, derivedKey) => {
            if (err) return reject(err);
            _cachedMainSecretKey = derivedKey;
            resolve(_cachedMainSecretKey);
        });
    });

    return _mainKeyPromise;
}

/**
 * Retourne l'ancienne clé (SHA-256 simple) pour migrer les données chiffrées
 * avant la mise à jour vers PBKDF2. Utilisée uniquement en fallback de déchiffrement.
 */
async function _getLegacyKey() {
    if (_cachedLegacyKey) return _cachedLegacyKey;
    const secretPath = path.join(app.getPath('appData'), 'GensLauncher', '.secret_key');
    let secret;
    try {
        secret = await fs.promises.access(secretPath).then(()=>true).catch(()=>false) ? await fs.promises.readFile(secretPath, 'utf8') : null;
    } catch (_) { secret = null; }
    if (!secret) secret = os.hostname() + '_' + (os.userInfo().username || 'user');
    _cachedLegacyKey = crypto.createHash('sha256').update(secret).digest();
    return _cachedLegacyKey;
}

async function encryptText(text) {
    if (safeStorage.isEncryptionAvailable()) {
        return 'safeStorage:' + safeStorage.encryptString(text).toString('hex');
    } else {
        const key = await _getMainProcSecretKey();
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        let enc = cipher.update(text, 'utf8', 'hex') + cipher.final('hex');
        const tag = cipher.getAuthTag().toString('hex');
        return 'aes-gcm:' + iv.toString('hex') + ':' + tag + ':' + enc;
    }
}

async function decryptText(hexText) {
    // Tentative 1 : nouvelle clé PBKDF2
    const key = await _getMainProcSecretKey();
    const result = _tryDecrypt(hexText, key);
    if (result !== null) return result;
    // Tentative 2 : ancienne clé SHA-256 (migration des données pré-PBKDF2)
    return _tryDecrypt(hexText, await _getLegacyKey());
}

function _tryDecrypt(hexText, key) {
    try {
        if (hexText.startsWith('safeStorage:') && safeStorage.isEncryptionAvailable()) {
            return safeStorage.decryptString(Buffer.from(hexText.split(':')[1], 'hex'));
        }
        if (hexText.startsWith('aes-gcm:')) {
            const parts = hexText.split(':');
            const iv = Buffer.from(parts[1], 'hex');
            const authTag = Buffer.from(parts[2], 'hex');
            const enc = parts[3];
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
            decipher.setAuthTag(authTag);
            return decipher.update(enc, 'hex', 'utf8') + decipher.final('utf8');
        }
        if (hexText.startsWith('aes:')) {
            const parts = hexText.split(':');
            const iv = Buffer.from(parts[1], 'hex');
            const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
            return decipher.update(parts.slice(2).join(':'), 'hex', 'utf8') + decipher.final('utf8');
        }
    } catch (_) { if (_ && _.code !== 'ENOENT') console.warn('Ignored error in crypto-utils.js:', _); }
    return null;
}

async function legacyDecryptText(hexText) {
    // Tentative avec la nouvelle clé PBKDF2 puis l'ancienne clé (migration)
    const pbkdf2Key = await _getMainProcSecretKey();
    for (const key of [pbkdf2Key, await _getLegacyKey()]) {
        try {
            const parts = hexText.split(':');
            if (parts.length > 1) {
                const iv = Buffer.from(parts.shift(), 'hex');
                const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
                const result = decipher.update(parts.join(':'), 'hex', 'utf8') + decipher.final('utf8');
                return result;
            }
        } catch (_) { if (_ && _.code !== 'ENOENT') console.warn('Ignored error in crypto-utils.js:', _); }
    }
    return null;
}

module.exports = {
    encryptText,
    decryptText,
    legacyDecryptText,
    ...(process.env.NODE_ENV === 'test' ? { _getMainProcSecretKey, _getLegacyKey } : {})
};
