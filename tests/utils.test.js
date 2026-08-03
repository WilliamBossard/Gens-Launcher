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
