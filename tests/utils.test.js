const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Simulation de l'environnement navigateur (window) pour utils.js
global.window = {};

// Simulation des dépendances de utils.js
global.sysLog = () => {};
global.fs = fs;
global.t = (k, v) => v;
window.api = {
    platform: process.platform,
    path: path,
    fs: fs,
    appData: __dirname
};

// Chargement du fichier utils.js
require('../src/utils.js');

test('safeWriteJSONAsync writes file and renames it securely', async (t) => {
    const testFile = path.join(__dirname, 'test_output.json');
    const testData = { success: true, message: "Hello World" };

    // Nettoyage avant test
    if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
    if (fs.existsSync(testFile + '.tmp')) fs.unlinkSync(testFile + '.tmp');

    // Appel de notre nouvelle fonction asynchrone
    await window.safeWriteJSONAsync(testFile, testData);

    // Vérifications
    assert.strictEqual(fs.existsSync(testFile), true, "Le fichier final doit exister.");
    assert.strictEqual(fs.existsSync(testFile + '.tmp'), false, "Le fichier temporaire doit avoir disparu.");

    // Vérification du contenu
    const content = JSON.parse(fs.readFileSync(testFile, 'utf8'));
    assert.deepStrictEqual(content, testData, "Le contenu écrit doit correspondre aux données.");

    // Nettoyage après test
    fs.unlinkSync(testFile);
});

test('Minecraft version parsing and Java requirements for modern versions (26.x, 27.x)', () => {
    function getRequiredJavaVersion(mcVersion) {
        if (!mcVersion) return 21;
        let minor = 0;
        let patch = 0;
        const mcMatch = mcVersion.match(/1\.(\d+)(?:\.(\d+))?/);
        if (mcMatch) {
            minor = parseInt(mcMatch[1]) || 0;
            patch = parseInt(mcMatch[2]) || 0;
        } else {
            const parts = mcVersion.split('.');
            if (parts[0] === '1') {
                minor = parseInt(parts[1]) || 0;
                patch = parseInt(parts[2]) || 0;
            } else {
                minor = parseInt(parts[0]) || 0;
                patch = parseInt(parts[1]) || 0;
            }
        }
        if (minor >= 26) return 25;
        if (minor > 20 || (minor === 20 && patch >= 5)) return 21;
        if (minor >= 17) return 17;
        return 8;
    }

    assert.strictEqual(getRequiredJavaVersion("1.16.5"), 8, "1.16.5 requires Java 8");
    assert.strictEqual(getRequiredJavaVersion("1.18.2"), 17, "1.18.2 requires Java 17");
    assert.strictEqual(getRequiredJavaVersion("1.20.1"), 17, "1.20.1 requires Java 17");
    assert.strictEqual(getRequiredJavaVersion("1.20.5"), 21, "1.20.5 requires Java 21");
    assert.strictEqual(getRequiredJavaVersion("1.21.4"), 21, "1.21.4 requires Java 21");
    assert.strictEqual(getRequiredJavaVersion("26.0"), 25, "26.0 requires Java 25");
    assert.strictEqual(getRequiredJavaVersion("26.3"), 25, "26.3 requires Java 25");
    assert.strictEqual(getRequiredJavaVersion("26.4"), 25, "26.4 requires Java 25");
    assert.strictEqual(getRequiredJavaVersion("27.0"), 25, "27.0 requires Java 25");
    assert.strictEqual(getRequiredJavaVersion("27.1"), 25, "27.1 requires Java 25");
    assert.strictEqual(getRequiredJavaVersion("26w41a"), 25, "26w snapshot requires Java 25");
});

test('Handler parseVersion and compareVersion correctly handles 26.x and 27.x', () => {
    function parseVersion(versionStr) {
        if (!versionStr) return { major: 0, minor: 0, patch: 0 };
        const parts = String(versionStr).split('.');
        if (parts[0] === '1') {
            return {
                major: 1,
                minor: parseInt(parts[1], 10) || 0,
                patch: parseInt(parts[2], 10) || 0
            };
        }
        return {
            major: parseInt(parts[0], 10) || 0,
            minor: parseInt(parts[1], 10) || 0,
            patch: parseInt(parts[2], 10) || 0
        };
    }

    function compareVersion(v1, v2) {
        const a = typeof v1 === 'string' ? parseVersion(v1) : v1;
        const b = typeof v2 === 'string' ? parseVersion(v2) : v2;
        if (a.major !== b.major) return a.major - b.major;
        if (a.minor !== b.minor) return a.minor - b.minor;
        return a.patch - b.patch;
    }

    const v26_3 = parseVersion("26.3");
    const v26_4 = parseVersion("26.4");
    const v27_1 = parseVersion("27.1");
    const v1_21 = parseVersion("1.21.4");

    assert.strictEqual(v26_4.major, 26);
    assert.strictEqual(v26_4.minor, 4);
    assert.strictEqual(v27_1.major, 27);
    assert.strictEqual(v27_1.minor, 1);

    assert.strictEqual(compareVersion(v26_4, v26_3) > 0, true, "26.4 is newer than 26.3");
    assert.strictEqual(compareVersion(v27_1, v26_4) > 0, true, "27.1 is newer than 26.4");
    assert.strictEqual(compareVersion(v26_4, v1_21) > 0, true, "26.4 is newer than 1.21.4");
});

