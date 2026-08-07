const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const mockElectron = {
    app: {
        getPath: () => os.tmpdir(),
    },
    safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (str) => Buffer.from(`ENCRYPTED_${str}`, 'utf8'),
        decryptString: (buf) => buf.toString('utf8').replace('ENCRYPTED_', '')
    }
};

const modulePath = require.resolve('../src/main/crypto-utils.js');
require.cache[require.resolve('electron')] = {
    id: 'electron',
    filename: 'electron',
    loaded: true,
    exports: mockElectron
};

process.env.NODE_ENV = 'test';
const { encryptText, decryptText, legacyDecryptText, _getMainProcSecretKey } = require('../src/main/crypto-utils.js');

test('Crypto Utils - safeStorage (mocked)', async (t) => {
    const text = 'hello world';
    const encrypted = await encryptText(text);

    assert.ok(encrypted.startsWith('safeStorage:'), 'Devrait utiliser safeStorage');

    const decrypted = await decryptText(encrypted);
    assert.strictEqual(decrypted, text, 'Le déchiffrement doit correspondre au texte original');
});

test('Crypto Utils - AES fallback', async (t) => {
    mockElectron.safeStorage.isEncryptionAvailable = () => false;

    const text = 'my super secret string';
    const encrypted = await encryptText(text);

    assert.ok(encrypted.startsWith('aes-gcm:'), 'Devrait utiliser le fallback AES-GCM');

    const decrypted = await decryptText(encrypted);
    assert.strictEqual(decrypted, text, 'Le déchiffrement AES doit correspondre au texte original');
});

test('Crypto Utils - Legacy AES', async (t) => {
    mockElectron.safeStorage.isEncryptionAvailable = () => false;

    const key = await _getMainProcSecretKey();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let enc = cipher.update('legacy string', 'utf8', 'hex') + cipher.final('hex');
    const legacyHex = iv.toString('hex') + ':' + enc;

    const decrypted = await legacyDecryptText(legacyHex);
    assert.strictEqual(decrypted, 'legacy string', 'Le déchiffrement legacy doit fonctionner');
});
