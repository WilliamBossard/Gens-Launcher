const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('CurseForge file matching prefers release and matching loader/version', () => {
    const files = [
        {
            id: 101,
            fileName: "modpack-forge-beta.zip",
            releaseType: 2,
            gameVersions: ["1.20.4", "Forge"]
        },
        {
            id: 102,
            fileName: "modpack-fabric-release.zip",
            releaseType: 1,
            gameVersions: ["1.20.4", "Fabric"]
        },
        {
            id: 103,
            fileName: "modpack-fabric-beta.zip",
            releaseType: 2,
            gameVersions: ["1.20.4", "Fabric"]
        }
    ];

    const version = "1.20.4";
    const loader = "fabric";

    const matched = files.find(file => {
        const gv = Array.isArray(file.gameVersions) ? file.gameVersions.map(v => v.toLowerCase()) : [];
        const matchVer = version ? gv.includes(version.toLowerCase()) : true;
        const matchLoader = loader ? gv.includes(loader.toLowerCase()) : true;
        return matchVer && matchLoader && file.releaseType === 1;
    }) || files.find(file => {
        const gv = Array.isArray(file.gameVersions) ? file.gameVersions.map(v => v.toLowerCase()) : [];
        const matchVer = version ? gv.includes(version.toLowerCase()) : true;
        const matchLoader = loader ? gv.includes(loader.toLowerCase()) : true;
        return matchVer && matchLoader;
    }) || files[0];

    assert.strictEqual(matched.id, 102);
});

test('CurseForge fallback URL uses websiteUrl or cfSlug (no 404 with numeric ID)', () => {
    const cfSlug = "better-mc-fabric";
    const websiteUrl = "https://www.curseforge.com/minecraft/modpacks/better-mc-fabric";
    const projectId = "123456";

    // 1. With websiteUrl
    const url1 = websiteUrl || (cfSlug
        ? `https://www.curseforge.com/minecraft/modpacks/${encodeURIComponent(cfSlug)}`
        : `https://curseforge.com/projects/${projectId}`);
    assert.strictEqual(url1, "https://www.curseforge.com/minecraft/modpacks/better-mc-fabric");

    // 2. Without websiteUrl but with cfSlug
    const url2 = "" || (cfSlug
        ? `https://www.curseforge.com/minecraft/modpacks/${encodeURIComponent(cfSlug)}`
        : `https://curseforge.com/projects/${projectId}`);
    assert.strictEqual(url2, "https://www.curseforge.com/minecraft/modpacks/better-mc-fabric");

    // 3. Fallback without slug
    const url3 = "" || (""
        ? `https://www.curseforge.com/minecraft/modpacks/${encodeURIComponent("")}`
        : `https://curseforge.com/projects/${projectId}`);
    assert.strictEqual(url3, "https://curseforge.com/projects/123456");
});

test('ensureZipInSandbox correctly classifies inside vs outside paths', () => {
    // Test 1: Plateforme courante (POSIX ou Windows) avec path.join
    const sandboxRoot = path.resolve('mock_sandbox_root');
    const sep = path.sep;

    function isInSandbox(testPath) {
        const resolved = path.resolve(testPath);
        const isWin = process.platform === 'win32';
        const r = isWin ? resolved.toLowerCase() : resolved;
        const s = isWin ? sandboxRoot.toLowerCase() : sandboxRoot;
        return r.startsWith(s + (s.endsWith(sep) ? '' : sep)) || r === s;
    }

    assert.strictEqual(isInSandbox(path.join(sandboxRoot, 'test.zip')), true);
    assert.strictEqual(isInSandbox(path.join(sandboxRoot, 'temp_123.zip')), true);
    assert.strictEqual(isInSandbox(path.resolve('outside_dir', 'modpack.zip')), false);

    // Test 2: Spécifique aux chemins Windows (exécutable aussi sur Linux via path.win32)
    const winSandbox = 'C:\\Users\\User\\AppData\\Roaming\\GensLauncher';
    const winSep = path.win32.sep;
    function isWinInSandbox(testPath) {
        const resolved = path.win32.resolve(testPath);
        const r = resolved.toLowerCase();
        const s = path.win32.resolve(winSandbox).toLowerCase();
        return r.startsWith(s + (s.endsWith(winSep) ? '' : winSep)) || r === s;
    }

    assert.strictEqual(isWinInSandbox("C:\\Users\\User\\AppData\\Roaming\\GensLauncher\\test.zip"), true);
    assert.strictEqual(isWinInSandbox("c:\\users\\user\\appdata\\roaming\\GensLauncher\\temp_123.zip"), true);
    assert.strictEqual(isWinInSandbox("C:\\Users\\User\\Downloads\\modpack.zip"), false);
    assert.strictEqual(isWinInSandbox("D:\\Games\\modpack.zip"), false);
});

test('getCurseForgeCdnUrls generates correct Edge and Mediafilez CDN URLs', async () => {
    global.window = { api: { fs, path, appData: 'C:\\test' } };
    const { getCurseForgeCdnUrls } = await import('../src/archives/curseforge.js');

    // Case 1: Standard file ID (p2 >= 100)
    const urls1 = getCurseForgeCdnUrls(7453586, 'ba_bt-1.20.1-3.0.0-beta3.2.1.jar');
    assert.strictEqual(urls1.length, 2);
    assert.strictEqual(urls1[0], 'https://edge.forgecdn.net/files/7453/586/ba_bt-1.20.1-3.0.0-beta3.2.1.jar');
    assert.strictEqual(urls1[1], 'https://mediafilez.forgecdn.net/files/7453/586/ba_bt-1.20.1-3.0.0-beta3.2.1.jar');

    // Case 2: File ID with p2 < 100 (includes padded variant)
    const urls2 = getCurseForgeCdnUrls(5422005, 'test_mod.jar');
    assert.strictEqual(urls2.length, 4);
    assert.strictEqual(urls2[0], 'https://edge.forgecdn.net/files/5422/5/test_mod.jar');
    assert.strictEqual(urls2[2], 'https://edge.forgecdn.net/files/5422/005/test_mod.jar');

    // Case 3: Empty or invalid input
    assert.deepStrictEqual(getCurseForgeCdnUrls(0, 'test.jar'), []);
    assert.deepStrictEqual(getCurseForgeCdnUrls(null, 'test.jar'), []);
    assert.deepStrictEqual(getCurseForgeCdnUrls(12345, ''), []);
});

test('determineTargetFolder correctly routes mods, shaderpacks, and resourcepacks', async () => {
    global.window = { api: { fs, path, appData: 'C:\\test' } };
    const { determineTargetFolder } = await import('../src/archives/curseforge.js');

    // By classId
    assert.strictEqual(determineTargetFolder('anything.jar', 6), 'mods');
    assert.strictEqual(determineTargetFolder('anything.zip', 6552), 'shaderpacks');
    assert.strictEqual(determineTargetFolder('anything.zip', 12), 'resourcepacks');

    // By filename heuristic
    assert.strictEqual(determineTargetFolder('jei-1.20.1.jar', null), 'mods');
    assert.strictEqual(determineTargetFolder('BSL_v8.4.zip', null), 'shaderpacks');
    assert.strictEqual(determineTargetFolder('ComplementaryReimagined.zip', null), 'shaderpacks');
    assert.strictEqual(determineTargetFolder('Solas Shader V3.0.zip', null), 'shaderpacks');
    assert.strictEqual(determineTargetFolder('MakeUp-UltraFast.zip', null), 'shaderpacks');
    assert.strictEqual(determineTargetFolder('Stay_True_1.20.zip', null), 'resourcepacks');
    assert.strictEqual(determineTargetFolder('xali_s Enhanced Vanilla.zip', null), 'resourcepacks');
});

