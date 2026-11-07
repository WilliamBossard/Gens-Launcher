// @ts-check

const { existsSafe } = require('./fs-utils');
const { app, safeStorage } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

/** @type {Buffer | null} */
let _cachedMainSecretKey = null;
/** @type {Buffer | null} */
let _cachedLegacyKey = null; // Ancienne clé SHA-256 simple — pour migration des données existantes

const PBKDF2_SALT_FILE = path.join(app.getPath('appData'), 'GensLauncher', '.key_salt');
const PBKDF2_ITERATIONS = 600000;

// Promise mémorisée : PBKDF2 ne s'exécute qu'une seule fois, de façon asynchrone
// (thread pool Node.js — ne bloque pas le Main Process Electron)
/** @type {Promise<Buffer> | null} */
let _mainKeyPromise = null;

/**
 * @returns {Promise<Buffer>}
 */
function _getMainProcSecretKey() {
    if (_mainKeyPromise) return _mainKeyPromise;

    _mainKeyPromise = (async () => {
        // 1. Lire ou générer le secret applicatif
        const secretPath = path.join(app.getPath('appData'), 'GensLauncher', '.secret_key');
        let secret = '';
        try {
            if (await existsSafe(secretPath)) {
                secret = await fs.promises.readFile(secretPath, 'utf8');
            } else {
                secret = crypto.randomUUID();
                await fs.promises.mkdir(path.dirname(secretPath), { recursive: true });
                await fs.promises.writeFile(secretPath, secret, { encoding: 'utf8', mode: 0o600 });
            }
        } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            console.warn(`[Sécurité] AVERTISSEMENT : Création/Lecture de .secret_key échouée (${errMsg}). Utilisation du fallback (hostname).`);
            secret = os.hostname() + '_' + (os.userInfo().username || 'user');
        }

        // 2. Générer/lire le salt dédié pour PBKDF2
        /** @type {Buffer} */
        let salt;
        try {
            if (await existsSafe(PBKDF2_SALT_FILE)) {
                salt = await fs.promises.readFile(PBKDF2_SALT_FILE);
            } else {
                salt = crypto.randomBytes(16);
                await fs.promises.writeFile(PBKDF2_SALT_FILE, salt, { encoding: 'binary', mode: 0o600 });
            }
        } catch (saltErr) {
            // Si le FS est inaccessible, on ne peut pas chiffrer de façon sécurisée.
            // Mieux vaut échouer tôt que silencieusement utiliser un salt prévisible.
            const saltErrMsg = saltErr instanceof Error ? saltErr.message : String(saltErr);
            throw new Error(
                `[crypto-utils] Impossible de lire/créer le salt PBKDF2 (${saltErrMsg}). ` +
                `Vérifiez les permissions sur %AppData%/GensLauncher/.`
            );
        }

        // 3. Dérivation asynchrone via thread pool — ne bloque pas l'event loop
        /** @type {Buffer} */
        const derivedKey = await new Promise((resolve, reject) => {
            crypto.pbkdf2(secret, salt, PBKDF2_ITERATIONS, 32, 'sha256', (err, key) => err ? reject(err) : resolve(key));
        });
        _cachedMainSecretKey = derivedKey;
        return derivedKey;
    })();

    const p = _mainKeyPromise;
    p.catch(() => { _mainKeyPromise = null; });
    return p;
}

/**
 * Retourne l'ancienne clé (SHA-256 simple) pour migrer les données chiffrées
 * avant la mise à jour vers PBKDF2. Utilisée uniquement en fallback de déchiffrement.
 * @returns {Promise<Buffer>}
 */
async function _getLegacyKey() {
    if (_cachedLegacyKey) return _cachedLegacyKey;
    const secretPath = path.join(app.getPath('appData'), 'GensLauncher', '.secret_key');
    /** @type {string | null} */
    let secret = null;
    try {
        secret = await existsSafe(secretPath) ? await fs.promises.readFile(secretPath, 'utf8') : null;
    } catch (_) { secret = null; }
    if (!secret) secret = os.hostname() + '_' + (os.userInfo().username || 'user');
    _cachedLegacyKey = crypto.createHash('sha256').update(secret).digest();
    return _cachedLegacyKey;
}

/**
 * @param {string} text
 * @returns {Promise<string>}
 */
async function encryptText(text) {
    if (await safeStorage.isAsyncEncryptionAvailable()) {
        return 'safeStorage:' + (await safeStorage.encryptStringAsync(text)).toString('hex');
    } else {
        const key = await _getMainProcSecretKey();
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        let enc = cipher.update(text, 'utf8', 'hex') + cipher.final('hex');
        const tag = cipher.getAuthTag().toString('hex');
        return 'aes-gcm:' + iv.toString('hex') + ':' + tag + ':' + enc;
    }
}

/**
 * @param {string} hexText
 * @returns {Promise<string | null>}
 */
async function decryptText(hexText) {
    // Tentative 1 : nouvelle clé PBKDF2
    const key = await _getMainProcSecretKey();
    const result = await _tryDecrypt(hexText, key);
    if (result !== null) return result;
    // Tentative 2 : ancienne clé SHA-256 (migration des données pré-PBKDF2)
    return _tryDecrypt(hexText, await _getLegacyKey());
}

/**
 * @param {string} hexText
 * @param {Buffer} key
 * @returns {Promise<string | null>}
 */
async function _tryDecrypt(hexText, key) {
    try {
        if (hexText.startsWith('safeStorage:') && await safeStorage.isAsyncEncryptionAvailable()) {
            const { result } = await safeStorage.decryptStringAsync(Buffer.from(hexText.split(':')[1], 'hex'));
            return result;
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
    } catch (err) { 
        /** @type {any} */
        const nodeErr = err;
        if (nodeErr && nodeErr.code !== 'ENOENT') {
            if (['EPERM', 'EACCES'].includes(nodeErr.code)) console.error('[Sécurité] Erreur OS critique (Permissions) lors du déchiffrement:', err);
            else console.warn('Ignored error in crypto-utils.js (_tryDecrypt):', err); 
        }
    }
    return null;
}

/**
 * @param {string} hexText
 * @returns {Promise<string | null>}
 */
async function legacyDecryptText(hexText) {
    // Tentative avec la nouvelle clé PBKDF2 puis l'ancienne clé (migration)
    const pbkdf2Key = await _getMainProcSecretKey();
    for (const key of [pbkdf2Key, await _getLegacyKey()]) {
        try {
            const parts = hexText.split(':');
            if (parts.length > 1) {
                const iv = Buffer.from(parts.shift() || '', 'hex');
                const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
                const result = decipher.update(parts.join(':'), 'hex', 'utf8') + decipher.final('utf8');
                return result;
            }
        } catch (err) { 
            /** @type {any} */
            const nodeErr = err;
            if (nodeErr && nodeErr.code !== 'ENOENT') {
                if (['EPERM', 'EACCES'].includes(nodeErr.code)) console.error('[Sécurité] Erreur OS critique (Permissions) lors du déchiffrement legacy:', err);
                else console.warn('Ignored error in crypto-utils.js (legacyDecryptText):', err); 
            }
        }
    }
    return null;
}

module.exports = {
    encryptText,
    decryptText,
    legacyDecryptText,
    ...(process.env.NODE_ENV === 'test' ? { _getMainProcSecretKey, _getLegacyKey } : {})
};
