const { app, safeStorage } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

let _cachedMainSecretKey = null;

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
    _cachedMainSecretKey = crypto.createHash('sha256').update(secret).digest();
    return _cachedMainSecretKey;
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
    try {
        if (hexText.startsWith('safeStorage:') && safeStorage.isEncryptionAvailable()) {
            return safeStorage.decryptString(Buffer.from(hexText.split(':')[1], 'hex'));
        }
        if (hexText.startsWith('aes-gcm:')) {
            const key = _getMainProcSecretKey();
            const parts = hexText.split(':');
            const iv = Buffer.from(parts[1], 'hex');
            const authTag = Buffer.from(parts[2], 'hex');
            const enc = parts[3];
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
            decipher.setAuthTag(authTag);
            return decipher.update(enc, 'hex', 'utf8') + decipher.final('utf8');
        }
        if (hexText.startsWith('aes:')) {
            const key = _getMainProcSecretKey();
            const parts = hexText.split(':');
            const iv = Buffer.from(parts[1], 'hex');
            const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
            return decipher.update(parts.slice(2).join(':'), 'hex', 'utf8') + decipher.final('utf8');
        }
    } catch (e) {
    }
    return null;
}

function legacyDecryptText(hexText) {
    try {
        const key = _getMainProcSecretKey();
        const parts = hexText.split(':');
        if (parts.length > 1) {
            const iv = Buffer.from(parts.shift(), 'hex');
            const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
            return decipher.update(parts.join(':'), 'hex', 'utf8') + decipher.final('utf8');
        } else {
            throw new Error("Déchiffrement avec IV nul bloqué par la sécurité (anti-pattern).");
        }
    } catch (e) {
        return null;
    }
}

module.exports = {
    encryptText,
    decryptText,
    legacyDecryptText,
    ...(process.env.NODE_ENV === 'test' ? { _getMainProcSecretKey } : {})
};
