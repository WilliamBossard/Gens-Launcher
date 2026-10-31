const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
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
    appData: os.tmpdir()
};

// Chargement du fichier utils.js
require('../src/utils.js');

test('safeWriteJSONAsync writes file and renames it securely', async (t) => {
    const testFile = path.join(os.tmpdir(), 'gens_test_output.json');
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

const Handler = require('../src/gens-core/components/handler.js');

test('Handler.parseRule evaluates Mojang single and multi-rule OS/arch conditions accurately', () => {
    const handler = new Handler({
        options: { os: 'windows', root: os.tmpdir(), overrides: {} },
        emit: () => {}
    });

    // 1. Single allow rule for windows -> should be allowed (parseRule returns false = not skipped)
    assert.strictEqual(handler.parseRule({
        name: 'org.lwjgl:lwjgl-platform:3.3.3:natives-windows',
        rules: [{ action: 'allow', os: { name: 'windows' } }]
    }), false);

    // 2. Single allow rule for osx -> should be skipped on windows (parseRule returns true)
    assert.strictEqual(handler.parseRule({
        name: 'ca.weblite:java-objc-bridge:1.1',
        rules: [{ action: 'allow', os: { name: 'osx' } }]
    }), true);

    // 3. Single disallow rule for osx -> should be allowed on windows (parseRule returns false)
    assert.strictEqual(handler.parseRule({
        name: 'org.lwjgl:lwjgl:3.3.3',
        rules: [{ action: 'disallow', os: { name: 'osx' } }]
    }), false);

    // 4. Multi-rule: allow all + disallow windows -> should be skipped on windows (parseRule returns true)
    assert.strictEqual(handler.parseRule({
        name: 'some.posix:lib:1.0',
        rules: [
            { action: 'allow' },
            { action: 'disallow', os: { name: 'windows' } }
        ]
    }), true);

    // 5. Multi-rule: allow all + disallow osx -> should be allowed on windows (parseRule returns false)
    assert.strictEqual(handler.parseRule({
        name: 'some.nonmac:lib:1.0',
        rules: [
            { action: 'allow' },
            { action: 'disallow', os: { name: 'osx' } }
        ]
    }), false);
});

test('Handler.getClasses preserves native classifiers while deduplicating overridden loader libraries', async () => {
    const handler = new Handler({
        options: { os: 'windows', root: os.tmpdir(), overrides: {} },
        emit: () => {}
    });

    handler.version = {
        libraries: [
            {
                name: 'org.lwjgl:lwjgl:3.3.3',
                downloads: { artifact: { path: 'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3.jar' } }
            },
            {
                name: 'org.lwjgl:lwjgl:3.3.3:natives-windows',
                downloads: { artifact: { path: 'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar' } }
            },
            {
                name: 'org.ow2.asm:asm:9.3',
                downloads: { artifact: { path: 'org/ow2/asm/asm/9.3/asm-9.3.jar' } }
            }
        ]
    };

    // Mock downloadToDirectory to return library names instead of hitting disk/network
    handler.downloadToDirectory = async (_dir, libs) => libs.map(l => l.name);

    const classJson = {
        libraries: [
            { name: 'org.lwjgl:lwjgl:3.3.3' },
            { name: 'org.ow2.asm:asm:9.6' }
        ]
    };

    const result = await handler.getClasses(classJson);

    assert.strictEqual(result.includes('org.lwjgl:lwjgl:3.3.3:natives-windows'), true, 'LWJGL natives-windows classifier must be preserved');
    assert.strictEqual(result.includes('org.ow2.asm:asm:9.6'), true, 'Newer ASM from loader must be included');
    assert.strictEqual(result.includes('org.ow2.asm:asm:9.3'), false, 'Older ASM from base version must be deduplicated');
});

test('Handler.getAssetIndexName uses version.assetIndex.id instead of custom loader name', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gens-assets-test-'));
    try {
        const handler = new Handler({
            options: {
                root: tmpRoot,
                version: { number: '1.20.1', custom: 'fabric-loader-0.16.0-1.20.1' },
                overrides: {}
            },
            emit: () => {}
        });
        handler.version = { assetIndex: { id: '5' } };

        assert.strictEqual(handler.getAssetIndexName(), '5', 'Should return Mojang assetIndex.id ("5") instead of custom loader name');

        // Legacy fallback test: if only <custom>.json exists on disk, use it
        const indexesDir = path.join(tmpRoot, 'assets', 'indexes');
        fs.mkdirSync(indexesDir, { recursive: true });
        fs.writeFileSync(path.join(indexesDir, 'fabric-loader-0.16.0-1.20.1.json'), '{}');
        assert.strictEqual(handler.getAssetIndexName(), 'fabric-loader-0.16.0-1.20.1', 'Should fallback to existing legacy custom index if default does not exist');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('Handler.getVersion rejects when both network and local cache fail', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gens-ver-test-'));
    try {
        const handler = new Handler({
            options: {
                root: tmpRoot,
                directory: path.join(tmpRoot, 'versions', '99.99'),
                version: { number: '99.99' },
                overrides: { url: { meta: 'https://invalid.example.invalid' } }
            },
            emit: () => {}
        });
        handler.fetchText = async () => { throw new Error('Network unreachable'); };

        await assert.rejects(
            () => handler.getVersion(),
            /Failed to fetch version_manifest\.json|Network unreachable/,
            'getVersion() must reject instead of resolving with an Error object'
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }

});


const MicrosoftAuth = require('../src/gens-core/components/auth.js');
const DiscordRPC = require('../src/gens-core/components/discord.js');

test('MicrosoftAuth.pollDeviceCode handles slow_down and transient network blips', async () => {
    const auth = new MicrosoftAuth();
    const originalFetch = global.fetch;
    let callCount = 0;

    global.fetch = async () => {
        callCount++;
        if (callCount === 1) {
            return { json: async () => ({ error: 'slow_down' }) };
        }
        if (callCount === 2) {
            throw new Error('Transient network error');
        }
        return { json: async () => ({ access_token: 'mock_msa_token', refresh_token: 'mock_refresh' }) };
    };

    try {
        const result = await auth.pollDeviceCode('dev_code_123', 0.001, 10);
        assert.strictEqual(result.access_token, 'mock_msa_token');
        assert.strictEqual(callCount, 3);
    } finally {
        global.fetch = originalFetch;
    }
});

test('DiscordRPC.disconnect clears timers and prevents automatic reconnect', () => {
    const rpc = new DiscordRPC('123456789');
    rpc.scheduleReconnect();
    assert.ok(rpc.reconnectTimer !== null, 'Reconnect timer should be scheduled initially');
    rpc.disconnect();
    assert.strictEqual(rpc.manualDisconnect, true);
    assert.strictEqual(rpc.reconnectTimer, null, 'Reconnect timer must be cleared on disconnect');
    rpc.scheduleReconnect();
    assert.strictEqual(rpc.reconnectTimer, null, 'scheduleReconnect must be a no-op after manual disconnect');
});

test('Handler.isModernForge handles undefined, null, legacy and modern forge IDs safely', () => {
    const handler = new Handler({ options: { root: os.tmpdir() }, emit: () => {} });
    
    assert.strictEqual(handler.isModernForge(null), false);
    assert.strictEqual(handler.isModernForge({ id: null }), false);
    assert.strictEqual(handler.isModernForge({}), false);
    assert.strictEqual(handler.isModernForge({ id: '1.7.10-Forge10.13.4.1614' }), false);
    assert.strictEqual(handler.isModernForge({ inheritsFrom: '1.7.10' }), false);
    assert.strictEqual(handler.isModernForge({ id: '1.12.2-forge1.12.2-14.23.5.2859' }), true);
    assert.strictEqual(handler.isModernForge({ inheritsFrom: '1.12.2', id: '1.12.2-forge1.12.2-14.23.5.2847' }), false);
    assert.strictEqual(handler.isModernForge({ id: '1.20.4-forge-49.0.30' }), true);
    assert.strictEqual(handler.isModernForge({ inheritsFrom: '1.20.4' }), true);
});

test('Handler.getForgedWrapped handles cached version JSON safely', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gens-fw-test-'));
    try {
        const handler = new Handler({
            options: {
                root: tmpRoot,
                overrides: { fw: { version: '1.6.0' } }
            },
            emit: () => {}
        });
        handler.version = { id: '1.20.1' };
        
        const forgeDir = path.join(tmpRoot, 'forge', '1.20.1');
        fs.mkdirSync(forgeDir, { recursive: true });
        const mockVersionJson = {
            id: '1.20.1-forge-47.2.0',
            inheritsFrom: '1.20.1',
            forgeWrapperVersion: '1.6.0',
            libraries: []
        };
        fs.writeFileSync(path.join(forgeDir, 'version.json'), JSON.stringify(mockVersionJson));

        const res = await handler.getForgedWrapped();
        assert.strictEqual(res.id, '1.20.1-forge-47.2.0');
        assert.strictEqual(res.forgeWrapperVersion, '1.6.0');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('pingServer address parsing correctly handles IPv4, IPv6, and custom ports', () => {
    const parseAddress = (address) => {
        let host = address;
        let port = 25565;
        if (typeof address === 'string') {
            const match = address.trim().match(/^(?:\[([a-fA-F0-9:]+)\]|([^:]+))(?::(\d+))?$/);
            if (match) {
                host = match[1] || match[2] || address;
                if (match[3]) {
                    const parsedPort = parseInt(match[3], 10);
                    if (!isNaN(parsedPort) && parsedPort >= 1 && parsedPort <= 65535) {
                        port = parsedPort;
                    }
                }
            }
        }
        return { host, port };
    };

    assert.deepStrictEqual(parseAddress('play.hypixel.net'), { host: 'play.hypixel.net', port: 25565 });
    assert.deepStrictEqual(parseAddress('127.0.0.1:25565'), { host: '127.0.0.1', port: 25565 });
    assert.deepStrictEqual(parseAddress('127.0.0.1:25577'), { host: '127.0.0.1', port: 25577 });
    assert.deepStrictEqual(parseAddress('[2001:db8::1]:25565'), { host: '2001:db8::1', port: 25565 });
    assert.deepStrictEqual(parseAddress('[::1]:19132'), { host: '::1', port: 19132 });
    assert.deepStrictEqual(parseAddress('[fe80::1]'), { host: 'fe80::1', port: 25565 });
});

test('Handler.pMap executes tasks with specified concurrency', async () => {
    let running = 0;
    let maxRunning = 0;
    const client = { options: { root: os.tmpdir() }, emit: () => {} };
    const handler = new Handler(client);

    const items = [10, 20, 30, 40, 50];
    const results = await handler.pMap(items, 2, async (item) => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise(r => setTimeout(r, 10));
        running--;
        return item * 2;
    });

    assert.deepStrictEqual(results, [20, 40, 60, 80, 100]);
    assert.ok(maxRunning <= 2, 'Concurrency should not exceed 2');
});

test('Handler.parseVersion correctly handles loader-prefixed versions', () => {
    const client = { options: { root: os.tmpdir() }, emit: () => {} };
    const handler = new Handler(client);

    const vFabric = handler.parseVersion('fabric-loader-0.15.7-1.20.4');
    assert.strictEqual(vFabric.major, 1);
    assert.strictEqual(vFabric.minor, 20);
    assert.strictEqual(vFabric.patch, 4);

    const vForge = handler.parseVersion('1.20.1-forge-47.2.0');
    assert.strictEqual(vForge.major, 1);
    assert.strictEqual(vForge.minor, 20);
    assert.strictEqual(vForge.patch, 1);

    const vQuilt = handler.parseVersion('quilt-loader-0.23.1-1.20.1');
    assert.strictEqual(vQuilt.major, 1);
    assert.strictEqual(vQuilt.minor, 20);
    assert.strictEqual(vQuilt.patch, 1);

    const vVanilla = handler.parseVersion('1.16.5');
    assert.strictEqual(vVanilla.major, 1);
    assert.strictEqual(vVanilla.minor, 16);
    assert.strictEqual(vVanilla.patch, 5);
});

test('Handler.parseRule handles arch regex matching (^x86$)', () => {
    const client = { options: { root: os.tmpdir() }, emit: () => {} };
    const handler = new Handler(client);

    const ruleMatchingX86 = {
        action: 'allow',
        os: { arch: '^x86$' }
    };
    const libX86 = { rules: [ruleMatchingX86] };
    
    // On x64 or arm64 arch, ^x86$ does not match, so the allow rule doesn't apply and lib is skipped (parseRule returns true)
    if (process.arch === 'x64' || process.arch === 'arm64') {
        assert.strictEqual(handler.parseRule(libX86), true, 'library with allow rule for ^x86$ should be skipped (parseRule returns true) on x64/arm64');
    }
});
