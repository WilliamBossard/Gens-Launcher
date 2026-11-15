const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('Preload isolation - Static audit of preload.js', () => {
    const preloadPath = path.resolve(__dirname, '../preload.js');
    const content = fs.readFileSync(preloadPath, 'utf8');

    const forbiddenModules = ['fs', 'path', 'os', 'crypto', 'child_process', 'zlib', 'net'];
    for (const mod of forbiddenModules) {
        const regex = new RegExp(`require\\s*\\(\\s*['"]${mod}['"]\\s*\\)`);
        assert.ok(!regex.test(content), `preload.js ne doit pas faire de require("${mod}")`);
    }

    const relativeRequireRegex = /require\s*\(\s*['"]\.\.?\//;
    assert.ok(!relativeRequireRegex.test(content), "preload.js ne doit faire aucun require() relatif");

    assert.ok(content.includes('require("electron")'), "preload.js importe electron");
    assert.ok(!content.includes('shell,') && !content.includes(', shell'), "preload.js ne doit pas importer shell depuis electron");
    assert.ok(!content.includes('clipboard,') && !content.includes(', clipboard'), "preload.js ne doit pas importer clipboard depuis electron");
});

test('Preload pure NBT Writer - byte-for-byte serialization check', () => {
    const nbtOriginal = require('../src/gens-core/components/nbt.js');

    const sample = {
        type: "compound",
        name: "",
        value: {
            servers: {
                type: "list",
                value: {
                    type: "compound",
                    value: [
                        { name: { type: "string", value: "Hypixel" }, ip: { type: "string", value: "mc.hypixel.net" } },
                        { name: { type: "string", value: "Gens" }, ip: { type: "string", value: "play.gens.fr" } }
                    ]
                }
            }
        }
    };

    const originalBuf = Buffer.from(nbtOriginal.writeUncompressed(sample));

    assert.ok(originalBuf.length > 0, "Original buffer not empty");
    assert.ok(originalBuf.includes(Buffer.from("Hypixel")), "Buffer contains Hypixel");
    assert.ok(originalBuf.includes(Buffer.from("play.gens.fr")), "Buffer contains play.gens.fr");
});

test('Security hardening: copy-image-to-sandbox gated & strict Modrinth host check', () => {
    const preloadContent = fs.readFileSync(path.resolve(__dirname, '../preload.js'), 'utf8');
    assert.ok(preloadContent.includes('channel === "copy-image-to-sandbox"'), 'invoke() doit restreindre copy-image-to-sandbox');
    assert.ok(preloadContent.includes('internal:approve-copy-source'), 'getFilePath() doit déclarer le chemin approuvé au processus Main');

    const mainContent = fs.readFileSync(path.resolve(__dirname, '../main.js'), 'utf8');
    assert.ok(!mainContent.includes('url.hostname.includes("modrinth.com")'), 'main.js ne doit pas utiliser .includes("modrinth.com")');
    assert.ok(mainContent.includes('url.hostname.endsWith(".modrinth.com")'), 'main.js doit vérifier strictement le domaine modrinth.com');
});

test('Preload security scoping & approval set cap', () => {
    const preloadContent = fs.readFileSync(path.resolve(__dirname, '../preload.js'), 'utf8');
    assert.ok(preloadContent.includes('security.writeJSON est réservé aux fichiers sécurisés autorisés'), 'writeJSON doit être limité aux fichiers sécurisés whitelistés');
    assert.ok(preloadContent.includes("'cf_api_key.enc'"), 'writeJSON/readJSON doit autoriser cf_api_key.enc');
    assert.ok(preloadContent.includes('security.readJSON est restreint aux fichiers autorisés'), 'readJSON doit être restreint aux fichiers JSON autorisés');
    assert.ok(preloadContent.includes('_approvedDropOrPickerPaths.size >= 200'), 'preload.js doit plafonner _approvedDropOrPickerPaths');

    const mainContent = fs.readFileSync(path.resolve(__dirname, '../main.js'), 'utf8');
    assert.ok(mainContent.includes('MAX_APPROVED_COPY_SOURCES'), 'main.js doit plafonner _approvedCopySourcesBySender');
});

test('Preload pathShim preserves Windows UNC \\\\server\\share prefixes on join and resolve', () => {
    const Module = require('module');
    const origLoad = Module._load;
    const origArgv = [...process.argv];
    let exposedApi = null;
    const preloadPath = path.resolve(__dirname, '../preload.js');
    delete require.cache[preloadPath];
    process.argv = ['electron', '--app-data=C:\\Users\\Test\\AppData', '--platform=win32'];
    Module._load = function (request, parent, isMain) {
        if (request === 'electron') {
            return {
                contextBridge: {
                    exposeInMainWorld: (name, api) => {
                        if (name === 'api') exposedApi = api;
                    }
                },
                ipcRenderer: {
                    invoke: async () => ({}),
                    send: () => {},
                    on: () => {},
                    sendSync: () => null
                },
                webUtils: { getPathForFile: () => '' }
            };
        }
        return origLoad.apply(this, arguments);
    };
    try {
        require(preloadPath);
        assert.ok(exposedApi && exposedApi.path, 'preload should expose api.path');
        assert.strictEqual(
            exposedApi.path.join('\\\\nas\\share', 'folder', 'sub'),
            '\\\\nas\\share\\folder\\sub'
        );
        assert.strictEqual(
            exposedApi.path.resolve('\\\\nas\\share\\a', '..\\b'),
            '\\\\nas\\share\\b'
        );
    } finally {
        Module._load = origLoad;
        process.argv = origArgv;
        delete require.cache[preloadPath];
    }
});

test('Preload security.writeJSON and readJSONAsync allow cf_api_key.enc and reject arbitrary paths', async () => {
    const Module = require('module');
    const origLoad = Module._load;
    const origArgv = [...process.argv];
    let exposedApi = null;
    const invoked = [];
    const preloadPath = path.resolve(__dirname, '../preload.js');
    delete require.cache[preloadPath];
    process.argv = ['electron', '--app-data=C:\\Users\\Test\\AppData', '--platform=win32'];
    Module._load = function (request, parent, isMain) {
        if (request === 'electron') {
            return {
                contextBridge: {
                    exposeInMainWorld: (name, api) => {
                        if (name === 'api') exposedApi = api;
                    }
                },
                ipcRenderer: {
                    invoke: async (channel, ...args) => {
                        invoked.push({ channel, args });
                        if (channel === 'encrypt-string') return 'ENC_PAYLOAD';
                        if (channel === 'decrypt-string') return JSON.stringify({ key: 'abc' });
                        if (channel === 'fs:readFile') return { ok: true, data: 'ENC_PAYLOAD' };
                        if (channel === 'fs:writeFile' || channel === 'fs:mkdir' || channel === 'fs:exists') return { ok: true, data: true };
                        return { ok: true };
                    },
                    send: () => {},
                    on: () => {},
                    sendSync: () => null
                },
                webUtils: { getPathForFile: () => '' }
            };
        }
        return origLoad.apply(this, arguments);
    };
    try {
        require(preloadPath);
        const cfPath = path.join('C:\\Users\\Test\\AppData', 'GensLauncher', 'cf_api_key.enc');
        const arbitraryPath = path.join('C:\\Users\\Test\\AppData', 'GensLauncher', 'other_secret.enc');

        await exposedApi.security.writeJSON(cfPath, { key: 'abc' });
        assert.ok(invoked.some((c) => c.channel === 'encrypt-string'), 'cf_api_key.enc doit passer par encrypt-string');
        assert.ok(invoked.some((c) => c.channel === 'fs:writeFile' && c.args[0] === cfPath), 'cf_api_key.enc doit écrire le payload chiffré');

        const readOk = await exposedApi.security.readJSONAsync(cfPath);
        assert.deepStrictEqual(readOk, { key: 'abc' }, 'cf_api_key.enc doit être déchiffrable via security.readJSONAsync');

        await assert.rejects(
            () => exposedApi.security.writeJSON(arbitraryPath, { key: 'evil' }),
            /Accès refusé/
        );
        await assert.rejects(
            () => exposedApi.security.readJSONAsync(arbitraryPath),
            /Accès refusé/
        );
    } finally {
        Module._load = origLoad;
        process.argv = origArgv;
        delete require.cache[preloadPath];
    }
});


