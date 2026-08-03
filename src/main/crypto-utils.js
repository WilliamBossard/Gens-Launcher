const { app, safeStorage } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

let _cachedMainSecretKey = null;
let _cachedLegacyKey = null; // Ancienne clé SHA-256 simple — pour migration des données existantes

const PBKDF2_SALT_FILE = path.join(app.getPath('appData'), 'GensLauncher', '.key_salt');
const PBKDF2_ITERATIONS = 100000;

function _getMainProcSecretKey() {
    if (_cachedMainSecretKey) return _cachedMainSecretKey;
    const secretPath = path.join(app.getPath("appData"), "GensLauncher", ".secret_key");
    let secret;
    try {
        if (fs.existsSync(secretPath)) {
            secret = fs.readFileSync(secretPath, 'utf8');
        } else {
            secret = crypto.randomUUID();
            fs.mkdirSync(path.dirname(secretPath), { recursive: true });
            fs.writeFileSync(secretPath, secret, { encoding: 'utf8', mode: 0o600 });
        }
    } catch (e) {
        secret = os.hostname() + "_" + (os.userInfo().username || "user");
    }

    // Générer/lire le salt dédié pour PBKDF2
    let salt;
    try {
        if (fs.existsSync(PBKDF2_SALT_FILE)) {
            salt = fs.readFileSync(PBKDF2_SALT_FILE);
        } else {
            salt = crypto.randomBytes(16);
            fs.writeFileSync(PBKDF2_SALT_FILE, salt, { encoding: 'binary', mode: 0o600 });
        }
    } catch (_) {
        salt = Buffer.from('GensLauncherSalt_v2', 'utf8'); // fallback statique si FS inaccessible
    }

    // Nouvelle clé via PBKDF2 (aligné sur Horizon — meilleure résistance au brute-force)
    _cachedMainSecretKey = crypto.pbkdf2Sync(secret, salt, PBKDF2_ITERATIONS, 32, 'sha256');
    return _cachedMainSecretKey;
}

/**
 * Retourne l'ancienne clé (SHA-256 simple) pour migrer les données chiffrées
 * avant la mise à jour vers PBKDF2. Utilisée uniquement en fallback de déchiffrement.
 */
function _getLegacyKey() {
    if (_cachedLegacyKey) return _cachedLegacyKey;
    const secretPath = path.join(app.getPath("appData"), "GensLauncher", ".secret_key");
    let secret;
    try {
        secret = fs.existsSync(secretPath) ? fs.readFileSync(secretPath, 'utf8') : null;
    } catch (_) { secret = null; }
    if (!secret) secret = os.hostname() + "_" + (os.userInfo().username || "user");
    _cachedLegacyKey = crypto.createHash('sha256').update(secret).digest();
    return _cachedLegacyKey;
}

function encryptText(text) {
    if (safeStorage.isEncryptionAvailable()) {
        return 'safeStorage:' + safeStorage.encryptString(text).toString('hex');
    } else {
        const key = _getMainProcSecretKey();
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        let enc = cipher.update(text, 'utf8', 'hex') + cipher.final('hex');
        const tag = cipher.getAuthTag().toString('hex');
        return 'aes-gcm:' + iv.toString('hex') + ':' + tag + ':' + enc;
    }
}

function decryptText(hexText) {
    // Tentative 1 : nouvelle clé PBKDF2
    const result = _tryDecrypt(hexText, _getMainProcSecretKey());
    if (result !== null) return result;
    // Tentative 2 : ancienne clé SHA-256 (migration des données pré-PBKDF2)
    return _tryDecrypt(hexText, _getLegacyKey());
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
    } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in crypto-utils.js:", _); }
    return null;
}

function legacyDecryptText(hexText) {
    // Tentative avec la nouvelle clé PBKDF2 puis l'ancienne clé (migration)
    for (const key of [_getMainProcSecretKey(), _getLegacyKey()]) {
        try {
            const parts = hexText.split(':');
            if (parts.length > 1) {
                const iv = Buffer.from(parts.shift(), 'hex');
                const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
                const result = decipher.update(parts.join(':'), 'hex', 'utf8') + decipher.final('utf8');
                return result;
            }
        } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in crypto-utils.js:", _); }
    }
    return null;
}

module.exports = {
    encryptText,
    decryptText,
    legacyDecryptText,
    ...(process.env.NODE_ENV === 'test' ? { _getMainProcSecretKey, _getLegacyKey } : {})
};
