'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

require.cache[require.resolve('electron')] = {
    id: 'electron',
    filename: 'electron',
    loaded: true,
    exports: {
        app: { getPath: () => os.tmpdir() },
        safeStorage: {
            isAsyncEncryptionAvailable: async () => false,
        },
        dialog: {
            showMessageBox: async () => ({ response: 0 }),
        }
    }
};

const { writeZipFromFiles } = require('../src/main/zip-utils');
const { createSandboxValidatorAsync } = require('../src/main/fs-utils');
const setupAuthHandlers = require('../src/main/ipc-auth');
const setupGameHandlers = require('../src/main/ipc-game');
const setupSystemHandlers = require('../src/main/ipc-system');

function createMockIpc() {
    /** @type {Map<string, Function>} */
    const handlers = new Map();
    /** @type {Map<string, Function>} */
    const listeners = new Map();
    return {
        handlers,
        listeners,
        ipcMain: {
            handle(channel, fn) { handlers.set(channel, fn); },
            on(channel, fn) { listeners.set(channel, fn); },
        }
    };
}

test('ipc-auth rejects invalid bearer tokens and invalid Mojang usernames', async () => {
    const { handlers, ipcMain } = createMockIpc();
    setupAuthHandlers({
        ipcMain,
        getMainWindow: () => null,
        safeDataDir: os.tmpdir(),
        mainLog: () => {},
        path,
        fs,
        crypto: require('node:crypto'),
        assertPathUnderSandbox: (p) => p,
    });

    const uploadSkin = handlers.get('upload-mojang-skin');
    assert.ok(uploadSkin);
    const badTokRes = await uploadSkin({}, { accessToken: "bad\r\ntoken", skinData: Buffer.alloc(16), variant: 'classic' });
    assert.equal(badTokRes.success, false);

    const fetchProf = handlers.get('fetch-mojang-profile');
    assert.ok(fetchProf);
    const badProfRes = await fetchProf({}, { token: "bad\ntoken" });
    assert.equal(badProfRes.success, false);

    const rawSkin = handlers.get('fetch-mojang-raw-skin');
    assert.ok(rawSkin);
    const badNameRes = await rawSkin({}, { name: "../evil/path" });
    assert.equal(badNameRes.success, false);
});

test('ipc-game force-stop-game rejects invalid instanceId', async () => {
    const { handlers, ipcMain } = createMockIpc();
    setupGameHandlers({
        ipcMain,
        getMainWindow: () => null,
        safeDataDir: os.tmpdir(),
        mainLog: () => {},
        path,
        fs,
        execFile: () => {},
        assertPathUnderSandbox: (p) => p,
        assertPathUnderSandboxAsync: async (p) => p,
        mainResolveInstanceFolder: (s) => String(s || '').replace(/[^a-z0-9]/gi, '_'),
        safeSend: () => {},
    });

    const forceStop = handlers.get('force-stop-game');
    assert.ok(forceStop);
    const res1 = await forceStop({}, null);
    assert.equal(res1.success, false);
    const res2 = await forceStop({}, '   ');
    assert.equal(res2.success, false);
});

test('ipc-system read-zip-text-batch reads multiple archives and blocks out-of-sandbox paths', async () => {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens-batch-'));
    try {
        const src1 = path.join(tmpDir, 'fabric.mod.json');
        const src2 = path.join(tmpDir, 'quilt.mod.json');
        await fs.promises.writeFile(src1, '{"id":"modone"}');
        await fs.promises.writeFile(src2, '{"id":"modtwo"}');

        const mod1 = path.join(tmpDir, 'mod1.jar');
        const mod2 = path.join(tmpDir, 'mod2.jar');
        await writeZipFromFiles(mod1, [{ fullPath: src1, relativePath: 'fabric.mod.json' }]);
        await writeZipFromFiles(mod2, [{ fullPath: src2, relativePath: 'quilt.mod.json' }]);

        const { handlers, ipcMain } = createMockIpc();
        const assertPathUnderSandboxAsync = createSandboxValidatorAsync(tmpDir);
        setupSystemHandlers({
            ipcMain,
            getMainWindow: () => null,
            mainLog: () => {},
            path,
            fs,
            execFile: () => {},
            assertPathUnderSandbox: (p) => p,
            assertPathUnderSandboxAsync,
            sanitizeShortcutName: (n) => n,
            shell: {},
            app: { getPath: () => tmpDir },
            safeDataDir: tmpDir,
        });

        const batchHandler = handlers.get('read-zip-text-batch');
        assert.ok(batchHandler);
        const outsidePath = path.join(os.tmpdir(), 'outside-sandbox.jar');
        const res = await batchHandler({}, {
            items: [mod1, mod2, outsidePath],
            entryNames: ['fabric.mod.json', 'quilt.mod.json']
        });

        assert.equal(res.success, true);
        assert.equal(res.results[mod1]?.success, true);
        assert.match(res.results[mod1]?.text, /modone/);
        assert.equal(res.results[mod2]?.success, true);
        assert.match(res.results[mod2]?.text, /modtwo/);
        assert.equal(res.results[outsidePath]?.success, false);
    } finally {
        await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
});

test('NeoForge prefix calculation handles 2-part and 3-part MC versions', () => {
    /** @param {string} mcVer */
    const computeNeoPrefix = (mcVer) => {
        const parts = mcVer.split('.');
        if (parts[0] === '1') {
            return `${parts[1] || '0'}.${parts[2] || '0'}.`;
        }
        return `${parts[0]}.${parts[1] || '0'}.`;
    };

    assert.equal(computeNeoPrefix('1.21'), '21.0.');
    assert.equal(computeNeoPrefix('1.21.1'), '21.1.');
    assert.equal(computeNeoPrefix('1.20.4'), '20.4.');
    assert.equal(computeNeoPrefix('26.1'), '26.1.');
});

test('ipc-system system:open-external remembers user-approved domains when checkbox is checked', async () => {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens-ext-'));
    let promptCount = 0;
    const openedUrls = [];
    require.cache[require.resolve('electron')].exports.dialog = {
        showMessageBox: async () => {
            promptCount++;
            return { response: 1, checkboxChecked: true };
        }
    };
    try {
        const { handlers, ipcMain } = createMockIpc();
        setupSystemHandlers({
            ipcMain,
            getMainWindow: () => null,
            mainLog: () => {},
            path,
            fs,
            execFile: () => {},
            assertPathUnderSandbox: (p) => p,
            assertPathUnderSandboxAsync: async (p) => p,
            sanitizeShortcutName: (n) => n,
            shell: { openExternal: async (u) => { openedUrls.push(u); } },
            app: { getPath: () => tmpDir },
            safeDataDir: tmpDir,
        });

        const openExt = handlers.get('system:open-external');
        assert.ok(openExt);

        const r1 = await openExt({}, 'https://custom-wiki.example.org/docs');
        assert.equal(r1.success, true);
        assert.equal(promptCount, 1);

        const r2 = await openExt({}, 'https://custom-wiki.example.org/other');
        assert.equal(r2.success, true);
        assert.equal(promptCount, 1);
        assert.equal(openedUrls.length, 2);
    } finally {
        await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
});

test('Audit 2026-11: zip-archive blocks "." file entry without deleting destDir', async () => {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens-zip-dot-'));
    try {
        const srcFile = path.join(tmpDir, 'payload.txt');
        const zipPath = path.join(tmpDir, 'malformed.zip');
        const destDir = path.join(tmpDir, 'dest');
        await fs.promises.writeFile(srcFile, 'hello', 'utf8');
        await fs.promises.mkdir(destDir, { recursive: true });
        await fs.promises.writeFile(path.join(destDir, 'sentinel.txt'), 'keep', 'utf8');

        await writeZipFromFiles(zipPath, [{ fullPath: srcFile, relativePath: '.' }]);

        const { Zip } = require('../src/gens-core/components/zip-archive');
        const z = new Zip(zipPath);
        await assert.rejects(() => z.extractAllTo(destDir), /Zip slip path traversal blocked/);
        assert.equal(fs.existsSync(path.join(destDir, 'sentinel.txt')), true);
    } finally {
        await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
});

test('Audit 2026-11: fetchWithSafeRedirects (pinnedHttpsRequest) rejects cleanly on pre-aborted AbortSignal', async () => {
    const { fetchWithSafeRedirects } = require('../src/gens-core/components/network-utils');
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
        () => fetchWithSafeRedirects('https://example.com/', {
            signal: controller.signal,
            lookupFn: async () => [{ address: '93.184.216.34', family: 4 }]
        }),
        /aborted/i
    );
});

test('Audit 2026-11: Handler.getClasses tolerates classJson without libraries array', async () => {
    const Handler = require('../src/gens-core/components/handler');
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens-handler-'));
    try {
        const h = new Handler({ emit: () => {}, options: { root: tmpDir, overrides: {}, version: { number: '1.21.1', type: 'release' } } });
        h.version = { libraries: [] };
        h.downloadToDirectory = async () => [];
        const libs = await h.getClasses({ mainClass: 'net.minecraft.client.main.Main' });
        assert.deepEqual(libs, []);
    } finally {
        await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
});

test('Audit 2026-11: system:export-diagnostic works without logs/ dir and leaves cwd clean', async () => {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens-diag-nologs-'));
    const diagZip = path.join(tmpDir, 'out.zip');
    try {
        const { handlers, ipcMain } = createMockIpc();
        const assertSandbox = createSandboxValidatorAsync(tmpDir);
        setupSystemHandlers({
            ipcMain,
            getMainWindow: () => null,
            mainLog: () => {},
            path,
            fs,
            execFile: () => {},
            assertPathUnderSandbox: (p) => p,
            assertPathUnderSandboxAsync: assertSandbox,
            sanitizeShortcutName: (n) => n,
            shell: { openExternal: async () => {} },
            app: { getPath: () => tmpDir, getVersion: () => '1.9.4' },
            safeDataDir: tmpDir,
        });

        const exportDiag = handlers.get('system:export-diagnostic');
        assert.ok(exportDiag);
        const res = await exportDiag({}, { destPath: diagZip });
        assert.equal(res.success, true);
        assert.equal(fs.existsSync(diagZip), true);
        assert.equal(fs.existsSync(path.join(process.cwd(), 'diagnostic.json')), false);
    } finally {
        await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
});

test('Audit 2026-11: quickPlay singleplayer allows spaces while blocking traversal, and createSandboxValidator blocks UNC', () => {
    const { createGameValidators } = require('../src/main/game-validation');
    const { createSandboxValidator } = require('../src/main/fs-utils');
    const safeDir = os.tmpdir();
    const assertSandbox = createSandboxValidator(safeDir);
    assert.throws(() => assertSandbox('\\\\server\\share\\file.txt'), /sandbox/i);

    const { validateLaunchOverrides } = createGameValidators({
        path, fs, os, safeDataDir: safeDir, assertPathUnderSandbox: assertSandbox
    });

    const spOpts = { quickPlay: { type: 'singleplayer', identifier: 'My Survival World' } };
    assert.doesNotThrow(() => validateLaunchOverrides(spOpts));
    assert.equal(spOpts.quickPlay.identifier, 'My Survival World');

    assert.throws(() => validateLaunchOverrides({ quickPlay: { type: 'singleplayer', identifier: '../escape' } }), /quickPlay/i);
    assert.throws(() => validateLaunchOverrides({ quickPlay: { type: 'multiplayer', identifier: 'play.example.com bad' } }), /quickPlay/i);
});

test('Audit 2026-11 Lot 1-2: renderer path guard blocks trust/cache files, validateLaunchOverrides blocks msa-cache, and darwin arm64 asset selection', () => {
    const { createRendererPathGuard, createSandboxValidator } = require('../src/main/fs-utils');
    const { createGameValidators } = require('../src/main/game-validation');
    const setupHorizonHandlers = require('../src/main/ipc-horizon');

    const safeDir = path.join(fs.realpathSync(os.tmpdir()), 'gens_remed_guard_test');
    const guard = createRendererPathGuard(safeDir);
    for (const rel of ['trusted_external_domains.json', 'github_release_cache.json', path.join('horizon', 'horizon_version.json')]) {
        const target = path.join(safeDir, rel);
        assert.throws(() => guard(target, 'read'), /politique de sécurité/i);
        assert.throws(() => guard(target, 'write'), /politique de sécurité/i);
        assert.throws(() => guard(target, 'delete'), /politique de sécurité/i);
    }

    const assertSandbox = createSandboxValidator(safeDir);
    const { validateLaunchOverrides } = createGameValidators({
        path, fs, os, safeDataDir: safeDir, assertPathUnderSandbox: assertSandbox
    });
    assert.throws(() => validateLaunchOverrides({
        overrides: { directory: path.join(safeDir, 'msa-cache') }
    }), /politique de sécurité/i);
    assert.throws(() => validateLaunchOverrides({
        overrides: { classes: [path.join(safeDir, 'horizon', 'auth', 'tokens.enc')] }
    }), /politique de sécurité/i);
    assert.doesNotThrow(() => validateLaunchOverrides({
        overrides: { log4jConfigurationFile: path.join(safeDir, 'instances', 'Test', 'log4j2.xml') }
    }));

    const ctx = {
        app: { isPackaged: false, getPath: () => safeDir },
        ipcMain: { handle: () => {}, on: () => {} },
        getMainWindow: () => null,
        safeDataDir: safeDir,
        mainLog: () => {},
        path, fs, execFile: () => {},
        spawn: () => {},
        safeSend: () => {}
    };
    setupHorizonHandlers(ctx);
    const assets = [
        { name: 'Horizon-macos-x64' },
        { name: 'Horizon-macos-arm64' }
    ];
    assert.equal(ctx.findCompatibleHorizonAsset(assets, 'darwin', 'arm64')?.name, 'Horizon-macos-arm64');
    assert.equal(ctx.findCompatibleHorizonAsset(assets, 'darwin', 'x64')?.name, 'Horizon-macos-x64');
});
