const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');

const { createSandboxValidator } = require('../src/main/fs-utils');
const setupGameHandlers = require('../src/main/ipc-game');
const setupHorizonHandlers = require('../src/main/ipc-horizon');
const setupFsHandlers = require('../src/main/ipc-fs');
const setupSystemHandlers = require('../src/main/ipc-system');
const { Ping } = require('../src/gens-core');
const Handler = require('../src/gens-core/components/handler');
const { writeZipFromFiles } = require('../src/main/zip-utils');

test('ipc-game validateLaunchOverrides blocks non-allowlisted domains, non-bare relative javaPath, and extended dangerous JVM args', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens_hardening_game_'));
    const sandboxDir = path.join(tmpRoot, 'AppData');
    await fs.promises.mkdir(sandboxDir, { recursive: true });
    const assertPathUnderSandbox = createSandboxValidator(sandboxDir);

    try {
        const listeners = new Map();
        const sentEvents = [];

        setupGameHandlers({
            app: { getPath: () => tmpRoot },
            ipcMain: {
                handle: () => {},
                on: (ch, fn) => listeners.set(ch, fn)
            },
            getMainWindow: () => ({
                isDestroyed: () => false,
                webContents: {
                    isDestroyed: () => false,
                    send: (ch, payload) => sentEvents.push({ ch, payload })
                }
            }),
            safeDataDir: sandboxDir,
            mainLog: () => {},
            path,
            fs,
            execFile: () => {},
            mainResolveInstanceFolder: (n) => n,
            safeSend: () => {},
            assertPathUnderSandbox
        });

        const launchListener = listeners.get('launch-game');
        assert.ok(typeof launchListener === 'function');

        // 1. Non-allowlisted HTTPS domain in overrides.url
        await launchListener({}, {
            instanceId: 'inst-domain-url',
            authorization: { access_token: 'x', uuid: 'u', name: 'p', meta: {} },
            version: { number: '1.20.4', type: 'release' },
            root: path.join(sandboxDir, 'instances', 'inst-domain-url'),
            overrides: { url: { meta: 'https://evil.example.com/meta' } }
        });
        assert.ok(sentEvents.some(e => e.ch === 'mc-close' && e.payload.instanceId === 'inst-domain-url' && e.payload.code === 1));

        // 2. Non-allowlisted HTTPS domain in overrides.fw.baseUrl
        sentEvents.length = 0;
        await launchListener({}, {
            instanceId: 'inst-domain-fw',
            authorization: { access_token: 'x', uuid: 'u', name: 'p', meta: {} },
            version: { number: '1.20.4', type: 'release' },
            root: path.join(sandboxDir, 'instances', 'inst-domain-fw'),
            overrides: { fw: { baseUrl: 'https://evil.example.com/fw/' } }
        });
        assert.ok(sentEvents.some(e => e.ch === 'mc-close' && e.payload.instanceId === 'inst-domain-fw' && e.payload.code === 1));

        // 3. Non-allowlisted HTTPS clientPackage
        sentEvents.length = 0;
        await launchListener({}, {
            instanceId: 'inst-domain-pkg',
            authorization: { access_token: 'x', uuid: 'u', name: 'p', meta: {} },
            version: { number: '1.20.4', type: 'release' },
            root: path.join(sandboxDir, 'instances', 'inst-domain-pkg'),
            clientPackage: 'https://evil.example.com/modpack.zip'
        });
        assert.ok(sentEvents.some(e => e.ch === 'mc-close' && e.payload.instanceId === 'inst-domain-pkg' && e.payload.code === 1));

        // 4. Non-bare relative javaPath (contains separator)
        sentEvents.length = 0;
        await launchListener({}, {
            instanceId: 'inst-rel-java',
            authorization: { access_token: 'x', uuid: 'u', name: 'p', meta: {} },
            version: { number: '1.20.4', type: 'release' },
            root: path.join(sandboxDir, 'instances', 'inst-rel-java'),
            javaPath: './bin/java'
        });
        assert.ok(sentEvents.some(e => e.ch === 'mc-close' && e.payload.instanceId === 'inst-rel-java' && e.payload.code === 1));

        // 5. Extended dangerous JVM args (-XX:CompileCommandFile, --patch-module, 2-token -Djava.library.path)
        for (const [id, customArgs] of [
            ['inst-jvm-cc', ['-XX:CompileCommandFile=/tmp/cmds']],
            ['inst-jvm-patch', ['--patch-module', 'java.base=/tmp/evil']],
            ['inst-jvm-lib2', ['-Djava.library.path', '/tmp/evil']]
        ]) {
            sentEvents.length = 0;
            await launchListener({}, {
                instanceId: id,
                authorization: { access_token: 'x', uuid: 'u', name: 'p', meta: {} },
                version: { number: '1.20.4', type: 'release' },
                root: path.join(sandboxDir, 'instances', id),
                customArgs
            });
            assert.ok(sentEvents.some(e => e.ch === 'mc-close' && e.payload.instanceId === id && e.payload.code === 1), `Expected rejection for ${id}`);
        }
    } finally {
        await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
});

test('ipc-horizon rejects tampered horizon_version.json HMAC signature', async () => {
    const Module = require('node:module');
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens_hardening_hzn_'));
    const horizonDir = path.join(tmpRoot, 'horizon');
    const exePath = path.join(horizonDir, process.platform === 'win32' ? 'Horizon.exe' : 'Horizon');
    const versionFile = path.join(horizonDir, 'horizon_version.json');
    await fs.promises.mkdir(horizonDir, { recursive: true });
    await fs.promises.writeFile(exePath, 'MZ-DUMMY');
    await fs.promises.writeFile(versionFile, JSON.stringify({
        version: 'v9.9.9',
        _sig: '0000000000000000000000000000000000000000000000000000000000000000'
    }));

    const origLoad = Module._load;
    const origFetch = global.fetch;
    Module._load = function (request, parent, isMain) {
        if (request === 'electron') {
            return {
                safeStorage: {
                    isAsyncEncryptionAvailable: async () => true,
                    encryptStringAsync: async (s) => Buffer.from(String(s), 'utf8'),
                    decryptStringAsync: async (b) => Buffer.from(b).toString('utf8')
                }
            };
        }
        return origLoad.apply(this, arguments);
    };
    global.fetch = async (url) => {
        if (String(url).includes('api.github.com')) {
            return new Response(JSON.stringify({
                tag_name: 'v1.4.2',
                assets: [{ name: process.platform === 'win32' ? 'Horizon-win-amd64.exe' : 'Horizon-linux-amd64', browser_download_url: 'https://github.com/WilliamBossard/Gens-Horizon/releases/download/v1.4.2/Horizon' }]
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        throw new Error('Unexpected fetch: ' + url);
    };

    try {
        const handlers = new Map();
        setupHorizonHandlers({
            ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
            safeDataDir: tmpRoot,
            horizonDir,
            mainLog: () => {},
            path,
            fs,
            crypto,
            spawn: () => {},
            app: { isPackaged: false, getVersion: () => '1.9.4' },
            horizonBinDir: horizonDir,
            horizonExePath: exePath,
            horizonVersionPath: versionFile,
            isWin: process.platform === 'win32',
            safeSend: () => {}
        });

        const statusRes = await handlers.get('check-horizon-status')({}, true);
        assert.strictEqual(statusRes.localVersion, null, 'Tampered horizon_version.json must fail closed to null localVersion');
        assert.strictEqual(statusRes.needsUpdate, true);
    } finally {
        Module._load = origLoad;
        global.fetch = origFetch;
        await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
});

test('ipc-fs validates fs:chmod mode range and enforces 64 MiB cap on fs:readFile', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens_hardening_fs_'));
    const assertPathUnderSandbox = createSandboxValidator(tmpRoot);

    try {
        const handlers = new Map();
        setupFsHandlers({
            ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
            safeDataDir: tmpRoot,
            mainLog: () => {},
            path,
            fs,
            os,
            app: { getPath: () => tmpRoot },
            assertPathUnderSandbox
        });

        const sampleFile = path.join(tmpRoot, 'test.txt');
        await fs.promises.writeFile(sampleFile, 'hello');

        const chmodHandler = handlers.get('fs:chmod');
        for (const badMode of [-1, 0o1000, 12.5, '755', NaN, null]) {
            const res = await chmodHandler({}, sampleFile, badMode);
            assert.strictEqual(res.ok, false, `fs:chmod must reject invalid mode: ${String(badMode)}`);
        }
        const okChmod = await chmodHandler({}, sampleFile, 0o644);
        assert.strictEqual(okChmod.ok, true);

        const largeFile = path.join(tmpRoot, 'huge.bin');
        const fh = await fs.promises.open(largeFile, 'w');
        await fh.truncate(65 * 1024 * 1024);
        await fh.close();

        const readFileHandler = handlers.get('fs:readFile');
        const readRes = await readFileHandler({}, largeFile, 'utf8');
        assert.strictEqual(readRes.ok, false, 'fs:readFile must reject files > 64 MiB');
        assert.match(readRes.error.message, /64/i);
    } finally {
        await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
});

test('ipc-system enforces 32 MiB cap on hash-buffer and runs extract-zip inside worker thread', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens_hardening_sys_'));
    const assertPathUnderSandbox = createSandboxValidator(tmpRoot);

    try {
        const handlers = new Map();
        setupSystemHandlers({
            ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
            getMainWindow: () => null,
            mainLog: () => {},
            path,
            fs,
            execFile: () => {},
            assertPathUnderSandbox,
            sanitizeShortcutName: (s) => s,
            shell: {},
            app: { getPath: () => tmpRoot },
            safeDataDir: tmpRoot,
            crypto
        });

        const hashBufferHandler = handlers.get('hash-buffer');
        const oversized = Buffer.alloc(32 * 1024 * 1024 + 1);
        const hashErr = await hashBufferHandler({}, { buffer: oversized, algo: 'sha256' });
        assert.strictEqual(hashErr.success, false);
        assert.match(hashErr.error, /32 Mo/i);

        const zipPath = path.join(tmpRoot, 'sample.zip');
        const srcDir = path.join(tmpRoot, 'src');
        const destDir = path.join(tmpRoot, 'out');
        await fs.promises.mkdir(path.join(srcDir, 'hello'), { recursive: true });
        const f1 = path.join(srcDir, 'hello', 'world.txt');
        const f2 = path.join(srcDir, 'hello', 'second.txt');
        await fs.promises.writeFile(f1, 'worker-extracted-content', 'utf8');
        await fs.promises.writeFile(f2, 'second-file', 'utf8');
        await writeZipFromFiles(zipPath, [
            { fullPath: f1, relativePath: 'hello/world.txt' },
            { fullPath: f2, relativePath: 'hello/second.txt' }
        ]);

        const progressEvents = [];
        const extractZipHandler = handlers.get('extract-zip');
        const res = await extractZipHandler({
            sender: {
                send: (ch, payload) => {
                    if (ch === 'zip-progress') progressEvents.push(payload.percent);
                }
            }
        }, { zipPath, destDir });

        assert.strictEqual(res.success, true);
        assert.strictEqual(await fs.promises.readFile(path.join(destDir, 'hello', 'world.txt'), 'utf8'), 'worker-extracted-content');
        assert.strictEqual(await fs.promises.readFile(path.join(destDir, 'hello', 'second.txt'), 'utf8'), 'second-file');
        assert.ok(progressEvents.includes(100), 'extract-zip should relay 100% zip-progress from worker');
    } finally {
        await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
});

test('pingServer handles fragmented VarInt header and JSON payload across multiple TCP chunks', async () => {
    function writeVarInt(v) {
        const bytes = [];
        let val = v >>> 0;
        while (true) {
            if ((val & ~0x7F) === 0) {
                bytes.push(val);
                return Buffer.from(bytes);
            }
            bytes.push((val & 0x7F) | 0x80);
            val >>>= 7;
        }
    }

    // Payload assez long (>= 128 octets) pour que le VarInt de longueur du paquet fasse 2 octets
    const payloadJson = JSON.stringify({
        version: { name: '1.21.4', protocol: 769 },
        players: { max: 20, online: 5 },
        description: 'Fragmented OK ' + 'x'.repeat(120)
    });
    const jsonBuf = Buffer.from(payloadJson, 'utf8');
    const body = Buffer.concat([writeVarInt(0x00), writeVarInt(jsonBuf.length), jsonBuf]);
    const packet = Buffer.concat([writeVarInt(body.length), body]);

    const origConnect = net.Socket.prototype.connect;
    const origWrite = net.Socket.prototype.write;
    const origSetTimeout = net.Socket.prototype.setTimeout;
    const origDestroy = net.Socket.prototype.destroy;

    const isStdio = (s) => s === process.stdout || s === process.stderr;
    net.Socket.prototype.setTimeout = function () { return isStdio(this) ? origSetTimeout.apply(this, arguments) : this; };
    net.Socket.prototype.destroy = function () { return isStdio(this) ? origDestroy.apply(this, arguments) : this; };
    net.Socket.prototype.connect = function (_port, _host, cb) {
        if (isStdio(this)) return origConnect.apply(this, arguments);
        if (typeof cb === 'function') setImmediate(cb);
        return this;
    };
    net.Socket.prototype.write = function () {
        if (isStdio(this)) return origWrite.apply(this, arguments);
        // Émet d'abord 1 seul octet (VarInt incomplet) puis le reste par fragments de 7 octets
        const firstChunk = packet.subarray(0, 1);
        setImmediate(() => {
            this.emit('data', firstChunk);
            let idx = 1;
            const emitNext = () => {
                if (idx >= packet.length) return;
                const end = Math.min(packet.length, idx + 7);
                this.emit('data', packet.subarray(idx, end));
                idx = end;
                if (idx < packet.length) setImmediate(emitNext);
            };
            setImmediate(emitNext);
        });
        return true;
    };

    try {
        const pong = await Ping.pingServer('127.0.0.1:25565', 3000);
        assert.ok(pong.description.startsWith('Fragmented OK'));
        assert.strictEqual(pong.players.online, 5);
    } finally {
        net.Socket.prototype.connect = origConnect;
        net.Socket.prototype.write = origWrite;
        net.Socket.prototype.setTimeout = origSetTimeout;
        net.Socket.prototype.destroy = origDestroy;
    }
});

test('Handler.downloadToDirectory returns deterministic ordered classpath even when downloads finish out of order', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens_hardening_cp_'));
    try {
        const client = {
            options: { root: tmpRoot, offline: false, overrides: {} },
            emit: () => {},
            aborted: false
        };
        const handler = new Handler(client);
        const delays = { 'a.jar': 60, 'b.jar': 30, 'c.jar': 5 };
        handler.verifyFileFast = async () => false;
        handler.checkSum = async () => true;
        handler.downloadAsync = async (_url, dir, name) => {
            await new Promise((r) => setTimeout(r, delays[name] || 0));
            await fs.promises.mkdir(dir, { recursive: true });
            await fs.promises.writeFile(path.join(dir, name), 'jar');
            return { failed: false, asset: null };
        };

        const libraries = [
            { name: 'com.example:a:1.0', downloads: { artifact: { path: 'com/example/a/1.0/a.jar', url: 'https://repo1.maven.org/maven2/a.jar' } } },
            { name: 'com.example:b:1.0', downloads: { artifact: { path: 'com/example/b/1.0/b.jar', url: 'https://repo1.maven.org/maven2/b.jar' } } },
            { name: 'com.example:c:1.0', downloads: { artifact: { path: 'com/example/c/1.0/c.jar', url: 'https://repo1.maven.org/maven2/c.jar' } } }
        ];

        const result = await handler.downloadToDirectory(path.join(tmpRoot, 'libraries'), libraries, 'classes');
        assert.deepStrictEqual(result.map((p) => path.basename(p)), ['a.jar', 'b.jar', 'c.jar']);
    } finally {
        await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
});

test('network-utils fetchWithSafeRedirects blocks non-HTTPS and private redirect targets', async () => {
    const { fetchWithSafeRedirects, downloadFileAsync } = require('../src/gens-core/components/network-utils');
    const origFetch = global.fetch;

    try {
        // 1. Redirection vers HTTP non sécurisé bloquée
        global.fetch = async (url) => {
            if (url === 'https://launchermeta.mojang.com/test.jar') {
                return new Response(null, { status: 302, headers: { location: 'http://launchermeta.mojang.com/test.jar' } });
            }
            throw new Error('Unexpected fetch URL: ' + url);
        };
        await assert.rejects(
            () => fetchWithSafeRedirects('https://launchermeta.mojang.com/test.jar'),
            /Blocked non-HTTPS URL/
        );

        // 2. Redirection vers 127.0.0.1 bloquée (SSRF)
        global.fetch = async (url) => {
            if (url === 'https://launchermeta.mojang.com/ssrf') {
                return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/admin' } });
            }
            throw new Error('Unexpected fetch URL: ' + url);
        };
        await assert.rejects(
            () => fetchWithSafeRedirects('https://launchermeta.mojang.com/ssrf'),
            /Blocked private\/local host/
        );

        // 3. Limite max 5 redirections respectée
        let hopCount = 0;
        global.fetch = async () => {
            hopCount++;
            return new Response(null, { status: 302, headers: { location: `https://launchermeta.mojang.com/hop/${hopCount}` } });
        };
        await assert.rejects(
            () => fetchWithSafeRedirects('https://launchermeta.mojang.com/start'),
            /Too many redirects/
        );

        // 4. downloadFileAsync échoue sans retry lorsqu'une redirection est bloquée
        let downloadFetchCalls = 0;
        global.fetch = async () => {
            downloadFetchCalls++;
            return new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data/' } });
        };
        const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens_ssrf_dl_'));
        try {
            const res = await downloadFileAsync('https://launchermeta.mojang.com/a.jar', tmpRoot, 'a.jar', true, 'test', { client: null, options: {} });
            assert.strictEqual(res.failed, true);
            assert.strictEqual(downloadFetchCalls, 1);
        } finally {
            await fs.promises.rm(tmpRoot, { recursive: true, force: true });
        }
    } finally {
        global.fetch = origFetch;
    }
});

test('Zip.readEntriesAsText extracts multiple entries in a single archive pass', async () => {
    const { Zip } = require('../src/gens-core/components/zip-archive');
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens_zip_multi_'));
    try {
        const vPath = path.join(tmpRoot, 'version.json');
        const iPath = path.join(tmpRoot, 'install_profile.json');
        const zipPath = path.join(tmpRoot, 'forge.jar');
        await fs.promises.writeFile(vPath, '{"id":"forge-test"}');
        await fs.promises.writeFile(iPath, '{"libraries":[]}');
        await writeZipFromFiles(zipPath, [
            { fullPath: vPath, relativePath: 'version.json' },
            { fullPath: iPath, relativePath: 'install_profile.json' }
        ]);

        const zip = new Zip(zipPath);
        const texts = await zip.readEntriesAsText(['version.json', 'install_profile.json', 'missing.json']);
        assert.strictEqual(texts['version.json'], '{"id":"forge-test"}');
        assert.strictEqual(texts['install_profile.json'], '{"libraries":[]}');
        assert.strictEqual(texts['missing.json'], undefined);
    } finally {
        await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
});

test('shortcuts.js escapes special chars for macOS and encodes instanceName in auto-launch arg', async () => {
    const setupShortcuts = require('../src/main/shortcuts');
    const handlers = new Map();
    const writtenLinks = [];
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens_shortcut_test_'));
    const origPlatform = process.platform;
    try {
        setupShortcuts({
            app: { getPath: () => tmpRoot },
            ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: () => {} },
            shell: {
                writeShortcutLink: (shortcutPath, _mode, options) => writtenLinks.push({ shortcutPath, options }),
                trashItem: async () => {}
            },
            fs,
            path,
            assertPathUnderSandbox: (p) => p,
            mainSafeDir: (s) => s,
            mainLog: () => {},
            sanitizeShortcutName: (s) => s.replace(/[^a-zA-Z0-9_-]/g, '_')
        });
        const createShortcut = handlers.get('create-desktop-shortcut');
        assert.ok(typeof createShortcut === 'function');
        if (origPlatform === 'win32') {
            const res = await createShortcut({}, { instanceName: 'Pack: Test 100%', iconPath: null });
            assert.strictEqual(res.success, true);
            assert.strictEqual(writtenLinks.length, 1);
            assert.strictEqual(writtenLinks[0].options.args, `--auto-launch="${encodeURIComponent('Pack: Test 100%')}"`);
        }
    } finally {
        await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
});

test('ipc-game check-java allows managed Java under sandbox/java/ while blocking sandbox/instances/', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(__dirname, '.tmp_javadir_test_'));
    const sandboxDir = path.join(tmpRoot, 'GensLauncher');
    const managedJava = path.join(sandboxDir, 'java', 'jre17', 'bin', process.platform === 'win32' ? 'javaw.exe' : 'java');
    const instanceJava = path.join(sandboxDir, 'instances', 'Pack', process.platform === 'win32' ? 'javaw.exe' : 'java');
    await fs.promises.mkdir(path.dirname(managedJava), { recursive: true });
    await fs.promises.mkdir(path.dirname(instanceJava), { recursive: true });
    await fs.promises.writeFile(managedJava, 'stub');
    await fs.promises.writeFile(instanceJava, 'stub');

    const origHomedir = os.homedir;
    os.homedir = () => path.join(tmpRoot, 'mock-home');
    try {
        const handlers = new Map();
        let execFileCalls = 0;
        setupGameHandlers({
            app: { getPath: () => tmpRoot },
            ipcMain: {
                handle: (ch, fn) => handlers.set(ch, fn),
                on: () => {}
            },
            getMainWindow: () => null,
            safeDataDir: sandboxDir,
            mainLog: () => {},
            path,
            fs,
            execFile: (_cmd, _args, _opts, cb) => {
                execFileCalls++;
                cb(null, '', 'openjdk version "17.0.10"');
            },
            mainResolveInstanceFolder: (n) => n,
            safeSend: () => {},
            assertPathUnderSandbox: createSandboxValidator(sandboxDir)
        });

        const checkJava = handlers.get('check-java');
        assert.ok(typeof checkJava === 'function');

        const allowedRes = await checkJava({}, managedJava);
        assert.strictEqual(allowedRes.err, null);
        assert.strictEqual(execFileCalls, 1);

        const blockedRes = await checkJava({}, instanceJava);
        assert.ok(blockedRes.err);
    } finally {
        os.homedir = origHomedir;
        await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
});

test('ipc-horizon processes valid JSON lines even when stdout chunk exceeds MAX_HORIZON_BUF', () => {
    const MAX_HORIZON_BUF = 2 * 1024 * 1024;
    let stdoutBuf = '';
    const parsed = [];

    const bigPadding = 'x'.repeat(MAX_HORIZON_BUF + 1024);
    const chunk = `{"type":"PROGRESS","value":50}\n{"type":"DONE","pad":"${bigPadding}"}\n{"partial":`;
    stdoutBuf += chunk;
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop() || '';
    if (stdoutBuf.length > MAX_HORIZON_BUF) {
        stdoutBuf = stdoutBuf.slice(-MAX_HORIZON_BUF);
    }
    for (const line of lines) {
        if (!line.trim()) continue;
        parsed.push(JSON.parse(line).type);
    }
    assert.deepStrictEqual(parsed, ['PROGRESS', 'DONE']);
    assert.strictEqual(stdoutBuf, '{"partial":');
});

test('ipc-horizon packaged mode refuses unsigned horizon_version.json downgrade while dev mode keeps working', async () => {
    const Module = require('node:module');
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens_hardening_hzn_unsigned_'));
    const horizonDir = path.join(tmpRoot, 'horizon');
    const exePath = path.join(horizonDir, process.platform === 'win32' ? 'Horizon.exe' : 'Horizon');
    const versionFile = path.join(horizonDir, 'horizon_version.json');
    await fs.promises.mkdir(horizonDir, { recursive: true });
    await fs.promises.writeFile(exePath, 'MZ-DUMMY');
    await fs.promises.writeFile(versionFile, JSON.stringify({ version: 'v1.0.0' }));

    const origLoad = Module._load;
    const origFetch = global.fetch;
    Module._load = function (request, parent, isMain) {
        if (request === 'electron') {
            return {
                safeStorage: {
                    isAsyncEncryptionAvailable: async () => true,
                    encryptStringAsync: async (s) => Buffer.from(String(s), 'utf8'),
                    decryptStringAsync: async (b) => Buffer.from(b).toString('utf8')
                }
            };
        }
        return origLoad.apply(this, arguments);
    };
    const requestedUrls = [];
    global.fetch = async (url) => {
        requestedUrls.push(String(url));
        return new Response(JSON.stringify({
            tag_name: 'v1.4.2',
            assets: [{ name: process.platform === 'win32' ? 'Horizon-win-amd64.exe' : 'Horizon-linux-amd64', browser_download_url: 'https://github.com/WilliamBossard/Gens-Horizon/releases/download/v1.4.2/Horizon' }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    try {
        // 1. Mode packagé : le tag non scellé 'v1.0.0' ne doit PAS être accepté comme version locale fiable
        const packagedHandlers = new Map();
        setupHorizonHandlers({
            ipcMain: { handle: (ch, fn) => packagedHandlers.set(ch, fn) },
            safeDataDir: tmpRoot,
            horizonDir,
            mainLog: () => {},
            path,
            fs,
            crypto,
            spawn: () => {},
            app: { isPackaged: true, getVersion: () => '1.9.4' },
            horizonBinDir: horizonDir,
            horizonExePath: exePath,
            horizonVersionPath: versionFile,
            isWin: process.platform === 'win32',
            safeSend: () => {}
        });
        const pkgStatus = await packagedHandlers.get('check-horizon-status')({}, true);
        assert.strictEqual(pkgStatus.localVersion, 'v0.0.0');
        assert.strictEqual(pkgStatus.needsUpdate, true);
        assert.ok(requestedUrls.every(u => !u.includes('v1.0.0')), 'Packaged mode must not query unsigned tag');

        // 2. Mode dev (!app.isPackaged) : le fichier sans _sig reste accepté pour les builds locaux
        const devHandlers = new Map();
        setupHorizonHandlers({
            ipcMain: { handle: (ch, fn) => devHandlers.set(ch, fn) },
            safeDataDir: tmpRoot,
            horizonDir,
            mainLog: () => {},
            path,
            fs,
            crypto,
            spawn: () => {},
            app: { isPackaged: false, getVersion: () => '1.9.4' },
            horizonBinDir: horizonDir,
            horizonExePath: exePath,
            horizonVersionPath: versionFile,
            isWin: process.platform === 'win32',
            safeSend: () => {}
        });
        const devStatus = await devHandlers.get('check-horizon-status')({}, true);
        assert.strictEqual(devStatus.localVersion, 'v1.0.0');
    } finally {
        Module._load = origLoad;
        global.fetch = origFetch;
        await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
});

test('updater pins exact SHA-256 of repo public.key and avoids shell exec', async () => {
    const updater = require('../src/main/updater');
    const pubKeyPath = path.join(__dirname, '..', 'public.key');
    const keyBytes = await fs.promises.readFile(pubKeyPath);
    const expectedSha = crypto.createHash('sha256').update(keyBytes).digest('hex').toLowerCase();
    assert.strictEqual(updater.APT_KEY_SHA256, expectedSha);

    const updaterSrc = await fs.promises.readFile(path.join(__dirname, '..', 'src', 'main', 'updater.js'), 'utf8');
    assert.ok(!/\brequire\(['"]child_process['"]\).*\bexec\b/.test(updaterSrc));
    assert.ok(!/\bexec\s*\(/.test(updaterSrc), 'updater.js must use execFile instead of exec');
});

test('network-utils blocks extended SSRF IPs and DNS rebinding to private addresses', async () => {
    const { isPrivateOrLocalHost, assertSafeRemoteUrl, fetchWithSafeRedirects } = require('../src/gens-core/components/network-utils');

    for (const host of ['0.0.0.0', '::', '::1', '100.64.0.1', '100.127.255.254', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254']) {
        assert.strictEqual(isPrivateOrLocalHost(host), true, `Expected ${host} to be flagged private/local`);
    }
    assert.throws(() => assertSafeRemoteUrl('https://[::ffff:127.0.0.1]/secret'), /Blocked private\/local host/);
    assert.throws(() => assertSafeRemoteUrl('https://0.0.0.0/secret'), /Blocked private\/local host/);

    await assert.rejects(
        () => fetchWithSafeRedirects('https://evil-rebind.example/mod.jar', {
            lookupFn: async () => [{ address: '127.0.0.1' }]
        }),
        /Blocked private\/local host/
    );
});

test('jvm-utils buildJVMArgs evaluates Mojang feature and regex arch rules uniformly', () => {
    const { buildJVMArgs } = require('../src/gens-core/components/jvm-utils');
    const osName = process.platform === 'win32' ? 'windows' : (process.platform === 'darwin' ? 'osx' : 'linux');

    const baseCtx = {
        version: {
            arguments: {
                jvm: [
                    { rules: [{ action: 'allow', features: { is_custom_flag: true } }], value: '-Dcustom.enabled=1' },
                    { rules: [{ action: 'allow', os: { name: osName, arch: '^x86_64$|^arm64$|^x86$' } }], value: '-Darch.matched=1' },
                    { rules: [{ action: 'allow', features: { forbidden_flag: true } }], value: '-Dshould.skip=1' }
                ]
            }
        },
        options: { root: os.tmpdir(), os: osName, overrides: {} },
        modifyJson: null,
        nativePath: path.join(os.tmpdir(), 'natives'),
        isAtLeast26: false,
        legacyJvmArg: '-Xss1M',
        assetIndexName: '1.21'
    };

    const withoutFeature = buildJVMArgs({ ...baseCtx, features: [] });
    assert.ok(!withoutFeature.includes('-Dcustom.enabled=1'));
    assert.ok(withoutFeature.includes('-Darch.matched=1'));
    assert.ok(!withoutFeature.includes('-Dshould.skip=1'));

    const withFeature = buildJVMArgs({ ...baseCtx, features: ['is_custom_flag'] });
    assert.ok(withFeature.includes('-Dcustom.enabled=1'));
});

test('ipc-system copy-file-to-sandbox rejects parent symlink/junction indirection', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens_hardening_symparent_'));
    const sandboxDir = path.join(tmpRoot, 'sandbox');
    const outsideDir = path.join(tmpRoot, 'outside');
    const linkParent = path.join(tmpRoot, 'linked_parent');
    await fs.promises.mkdir(sandboxDir, { recursive: true });
    await fs.promises.mkdir(outsideDir, { recursive: true });

    const realZip = path.join(outsideDir, 'pack.zip');
    await fs.promises.writeFile(realZip, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]));

    let symlinkCreated = false;
    try {
        await fs.promises.symlink(outsideDir, linkParent, process.platform === 'win32' ? 'junction' : 'dir');
        symlinkCreated = true;
    } catch (_) {
        // Environnement sans permission de création de lien symbolique
    }

    try {
        if (symlinkCreated) {
            const handlers = new Map();
            setupSystemHandlers({
                ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
                getMainWindow: () => null,
                mainLog: () => {},
                path,
                fs,
                execFile: () => {},
                assertPathUnderSandbox: createSandboxValidator(sandboxDir),
                sanitizeShortcutName: (s) => s,
                shell: {},
                app: { getPath: () => tmpRoot },
                safeDataDir: sandboxDir,
                isApprovedCopySource: () => true
            });
            const copyHandler = handlers.get('copy-file-to-sandbox');
            const viaLink = path.join(linkParent, 'pack.zip');
            const res = await copyHandler({ sender: { id: 1 } }, { srcPath: viaLink, destName: 'pack.zip' });
            assert.strictEqual(res.success, false);
            assert.match(res.error, /symbo|jonction/i);
        }
    } finally {
        await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
});

test('ipc-game enforces extended JVM blocklist and separated launcher domain allowlists', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens_jvm_domains_'));
    const sandboxDir = path.join(tmpRoot, 'AppData');
    await fs.promises.mkdir(sandboxDir, { recursive: true });
    const assertPathUnderSandbox = createSandboxValidator(sandboxDir);

    try {
        const listeners = new Map();
        const sentEvents = [];
        setupGameHandlers({
            app: { getPath: () => tmpRoot },
            ipcMain: {
                handle: () => {},
                on: (ch, fn) => listeners.set(ch, fn)
            },
            getMainWindow: () => ({
                isDestroyed: () => false,
                webContents: {
                    isDestroyed: () => false,
                    send: (ch, payload) => sentEvents.push({ ch, payload })
                }
            }),
            safeDataDir: sandboxDir,
            mainLog: () => {},
            path,
            fs,
            execFile: () => {},
            mainResolveInstanceFolder: (n) => n,
            safeSend: () => {},
            assertPathUnderSandbox
        });
        const launchListener = listeners.get('launch-game');
        assert.ok(typeof launchListener === 'function');

        for (const [id, customArgs] of [
            ['inst-xloggc', ['-Xloggc:/tmp/gc.log']],
            ['inst-xxlog', ['-XX:LogFile=/tmp/vm.log']],
            ['inst-archive', ['-XX:ArchiveClassesAtExit=/tmp/a.jsa']],
            ['inst-shared', ['-XX:SharedArchiveFile=/tmp/s.jsa']],
            ['inst-trace', ['-Djdk.instrument.traceUsage=true']],
            ['inst-sec', ['-Djava.security.manager=allow']],
            ['inst-pol2', ['-Djava.security.policy', '=/tmp/pol']],
        ]) {
            sentEvents.length = 0;
            await launchListener({}, {
                instanceId: id,
                authorization: { access_token: 'x', uuid: 'u', name: 'p', meta: {} },
                version: { number: '1.20.4', type: 'release' },
                root: path.join(sandboxDir, 'instances', id),
                customArgs
            });
            assert.ok(
                sentEvents.some(e => e.ch === 'mc-close' && e.payload.instanceId === id && e.payload.code === 1),
                `JVM arg ${customArgs.join(' ')} doit être rejeté`
            );
        }

        // github.com bloqué dans overrides.url mais autorisé dans overrides.fw.baseUrl (ForgeWrapper)
        sentEvents.length = 0;
        await launchListener({}, {
            instanceId: 'inst-url-gh',
            authorization: { access_token: 'x', uuid: 'u', name: 'p', meta: {} },
            version: { number: '1.20.4', type: 'release' },
            root: path.join(sandboxDir, 'instances', 'inst-url-gh'),
            overrides: { url: { meta: 'https://github.com/evil/repo' } }
        });
        assert.ok(sentEvents.some(e => e.ch === 'mc-close' && e.payload.instanceId === 'inst-url-gh' && e.payload.code === 1));
    } finally {
        await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
});

test('launchCore mergeInstanceConfigFromDisk filters dangerous cloud jvmArgs via strict allowlist', async () => {
    const baseTmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens_cloud_jvmargs_'));
    const prevWindow = global.window;
    try {
        global.window = {
            api: {
                appData: baseTmp,
                platform: process.platform,
                fs: { promises: { readFile: fs.promises.readFile, writeFile: fs.promises.writeFile, mkdir: fs.promises.mkdir, access: fs.promises.access, readdir: fs.promises.readdir, stat: fs.promises.stat, unlink: fs.promises.unlink, rename: fs.promises.rename } },
                path,
                os,
            },
            safeDir: (s) => s,
            safeWriteJSONAsync: async () => {},
            existsSafe: async (p) => { try { await fs.promises.access(p); return true; } catch { return false; } },
            showToast: () => {},
        };
        const { store } = await import('../src/store.js');
        const { mergeInstanceConfigFromDisk } = await import('../src/launch/launchCore.js');
        store.instancesRoot = path.join(baseTmp, 'GensLauncher', 'instances');
        store.instanceFile = path.join(baseTmp, 'GensLauncher', 'instances.json');
        const instDir = path.join(store.instancesRoot, 'CloudJvmInst');
        await fs.promises.mkdir(path.join(instDir, 'gens'), { recursive: true });
        const inst = { name: 'CloudJvmInst', version: '1.20.4', jvmArgs: '', _localConfigUpdatedAt: 100 };
        store.allInstances = [inst];

        await fs.promises.writeFile(
            path.join(instDir, 'gens', 'launcher_config.json'),
            JSON.stringify({
                _cloudExportedAt: 500,
                jvmArgs: '-Xmx4G -Xms2G -XX:+UseG1GC -XX:MaxGCPauseMillis=50 -javaagent:/tmp/evil.jar -Xloggc:/tmp/gc.log -Djdk.instrument.traceUsage=true @/tmp/args'
            })
        );

        await mergeInstanceConfigFromDisk('CloudJvmInst');
        assert.strictEqual(inst.jvmArgs, '-Xmx4G -Xms2G -XX:+UseG1GC -XX:MaxGCPauseMillis=50');
    } finally {
        global.window = prevWindow;
        await fs.promises.rm(baseTmp, { recursive: true, force: true });
    }
});

test('zip-utils writeZipFromFiles handles batched Central Directory (>256KB) cleanly', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens_zip_cd_batch_'));
    const { openZip } = require('../src/main/zip-utils');
    try {
        const filesDir = path.join(tmpRoot, 'src');
        await fs.promises.mkdir(filesDir, { recursive: true });
        const srcFile = path.join(filesDir, 'sample.txt');
        await fs.promises.writeFile(srcFile, 'ok');

        // ~3200 entrées avec noms longs -> Central Directory > 256 Ko (déclenche plusieurs flushs batch)
        const entries = [];
        for (let i = 0; i < 3200; i++) {
            entries.push({
                fullPath: srcFile,
                relativePath: `nested/directory/padding_segment_for_central_directory_batching/entry_${String(i).padStart(4, '0')}.txt`
            });
        }
        const zipPath = path.join(tmpRoot, 'many.zip');
        await writeZipFromFiles(zipPath, entries, { level: 1 });

        const reader = await openZip(zipPath);
        try {
            let count = 0;
            let lastFilename = '';
            for await (const entry of reader) {
                count++;
                lastFilename = entry.filename;
            }
            assert.strictEqual(count, 3200);
            assert.strictEqual(lastFilename, entries[3199].relativePath);
        } finally {
            await reader.close();
        }
    } finally {
        await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
});

test('Static hardening audit: PureNBTWriter bounds, main.js lang regex, ModsUI icon_url escape', () => {
    const preloadContent = fs.readFileSync(path.resolve(__dirname, '../preload.js'), 'utf8');
    assert.ok(preloadContent.includes('depth > 64'), 'PureNBTWriter doit borner la profondeur NBT');
    assert.ok(preloadContent.includes('Type de tag NBT inconnu'), 'PureNBTWriter doit rejeter les types inconnus');

    const mainContent = fs.readFileSync(path.resolve(__dirname, '../main.js'), 'utf8');
    assert.ok(mainContent.includes('/^[a-zA-Z]{2,8}(?:[-_][a-zA-Z0-9]{2,8})?$/'), 'main.js doit valider sets.language');

    const modsUiContent = fs.readFileSync(path.resolve(__dirname, '../src/ui/ModsUI.js'), 'utf8');
    assert.ok(!modsUiContent.includes('? mod.icon_url : ""'), 'ModsUI.js ne doit pas injecter mod.icon_url sans escapeHTML');
    assert.ok(modsUiContent.includes('/^https:\\/\\//i.test(rawThumb)'), 'ModsUI.js doit imposer https:// sur CurseForge thumbnailUrl');
    assert.ok(modsUiContent.includes('CSS.escape('), 'ModsUI.js doit échapper projectId dans querySelectorAll');

    const utilsContent = fs.readFileSync(path.resolve(__dirname, '../src/utils.js'), 'utf8');
    assert.ok(utilsContent.includes('finally {\n        clearTimeout(id);\n    }') || utilsContent.includes('finally {\r\n        clearTimeout(id);\r\n    }'), 'fetchWithTimeout doit nettoyer setTimeout dans finally');

    const ipcSystemContent = fs.readFileSync(path.resolve(__dirname, '../src/main/ipc-system.js'), 'utf8');
    assert.ok(ipcSystemContent.includes('WORKER_TIMEOUT_MS'), 'extract-zip doit borner la durée du worker avec WORKER_TIMEOUT_MS');
});

test('zip-archive removes pre-existing directory or symlink at entry destination before writing', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens_zip_replace_dest_'));
    const { Zip } = require('../src/gens-core/components/zip-archive');
    try {
        const srcDir = path.join(tmpRoot, 'src');
        const outDir = path.join(tmpRoot, 'out');
        await fs.promises.mkdir(srcDir, { recursive: true });
        await fs.promises.mkdir(path.join(outDir, 'config', 'nested'), { recursive: true });
        await fs.promises.writeFile(path.join(srcDir, 'config'), 'new-regular-file');
        await fs.promises.writeFile(path.join(outDir, 'config', 'nested', 'stale.txt'), 'old');

        const zipPath = path.join(tmpRoot, 'test.zip');
        await writeZipFromFiles(zipPath, [{ fullPath: path.join(srcDir, 'config'), relativePath: 'config' }], { level: 1 });

        const archive = new Zip(zipPath);
        await archive.extractAllTo(outDir, true);
        const extracted = await fs.promises.readFile(path.join(outDir, 'config'), 'utf8');
        assert.strictEqual(extracted, 'new-regular-file');
    } finally {
        await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
});

test('network-utils flags uncompressed IPv6 loopback variants as private/local', () => {
    const { isPrivateOrLocalHost } = require('../src/gens-core/components/network-utils');
    assert.strictEqual(isPrivateOrLocalHost('0000:0000:0000:0000:0000:0000:0000:0001'), true);
    assert.strictEqual(isPrivateOrLocalHost('0:0:0:0:0:0:0:0'), true);
    assert.strictEqual(isPrivateOrLocalHost('8.8.8.8'), false);
});

test('ipc-horizon validates SHA256SUMS URL host and uses timingSafeEqual for GitHub cache HMAC', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens_horizon_sec_'));
    const horizonDir = path.join(tmpRoot, 'bin');
    await fs.promises.mkdir(horizonDir, { recursive: true });
    const exePath = path.join(horizonDir, process.platform === 'win32' ? 'Horizon-win-amd64.exe' : 'Horizon-linux-amd64');
    const versionFile = path.join(horizonDir, 'horizon_version.json');
    const setupHorizonHandlers = require('../src/main/ipc-horizon');

    const Module = require('module');
    const origLoad = Module._load;
    const origFetch = global.fetch;
    Module._load = function (request, parent, isMain) {
        if (request === 'electron') {
            return {
                safeStorage: {
                    isAsyncEncryptionAvailable: async () => true,
                    encryptStringAsync: async (s) => Buffer.from(String(s), 'utf8'),
                    decryptStringAsync: async (b) => Buffer.from(b).toString('utf8')
                }
            };
        }
        return origLoad.apply(this, arguments);
    };

    const fetchedUrls = [];
    const assetName = process.platform === 'win32' ? 'Horizon-win-amd64.exe' : 'Horizon-linux-amd64';
    global.fetch = async (targetUrl) => {
        const u = String(targetUrl);
        fetchedUrls.push(u);
        return new Response(JSON.stringify({
            tag_name: 'v1.9.0',
            assets: [
                { name: assetName, browser_download_url: `https://github.com/WilliamBossard/Gens-Horizon/releases/download/v1.9.0/${assetName}` },
                { name: 'SHA256SUMS.txt', browser_download_url: 'https://evil.example.com/SHA256SUMS.txt' }
            ]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    try {
        const handlers = new Map();
        setupHorizonHandlers({
            ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
            safeDataDir: tmpRoot,
            horizonDir,
            mainLog: () => {},
            path,
            fs,
            crypto,
            spawn: () => {},
            app: { isPackaged: true, getVersion: () => '1.9.4' },
            horizonBinDir: horizonDir,
            horizonExePath: exePath,
            horizonVersionPath: versionFile,
            isWin: process.platform === 'win32',
            safeSend: () => {}
        });

        const installRes = await handlers.get('install-horizon')({ sender: null }, false);
        assert.strictEqual(installRes.success, false);
        assert.ok(fetchedUrls.every(u => !u.includes('evil.example.com')), 'install-horizon must reject untrusted SHA256SUMS URL before fetching');

        const horizonSrc = fs.readFileSync(path.resolve(__dirname, '../src/main/ipc-horizon.js'), 'utf8');
        assert.ok(horizonSrc.includes('verifyTimingSafeHex(parsed._sig, expectedSig)'), 'GitHub cache HMAC check must use verifyTimingSafeHex');
    } finally {
        Module._load = origLoad;
        global.fetch = origFetch;
        await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
});

test('Launch session accounting, SettingsUI CSP sanitizer, and dead nbt:write removal checks', () => {
    const launchManagerSrc = fs.readFileSync(path.resolve(__dirname, '../src/launch/LaunchManager.js'), 'utf8');
    assert.ok(!launchManagerSrc.includes('inst.launchCount'), 'LaunchManager ne doit plus incrémenter launchCount avant mc-started');
    assert.ok(!launchManagerSrc.includes('_tempSessionStart'), 'LaunchManager ne doit plus initialiser _tempSessionStart avant mc-started');

    const launchUiSrc = fs.readFileSync(path.resolve(__dirname, '../src/launch/launchUI.js'), 'utf8');
    assert.ok(launchUiSrc.includes('startedInst.launchCount ='), 'launchUI mc-started doit incrémenter launchCount');
    assert.ok(launchUiSrc.includes('if (hadStartedSession)'), 'launchUI mc-close doit ignorer playTime/lastPlayed si la partie n’a jamais démarré');

    const settingsUiSrc = fs.readFileSync(path.resolve(__dirname, '../src/ui/SettingsUI.js'), 'utf8');
    assert.ok(settingsUiSrc.includes("base, form, style, meta"), 'sanitizeHtmlForCsp doit aussi supprimer style et meta');
    assert.ok(settingsUiSrc.includes('window.escapeHTML(html)'), 'sanitizeHtmlForCsp doit fail-closed via escapeHTML en cas d’erreur DOMParser');

    const ipcSysSrc = fs.readFileSync(path.resolve(__dirname, '../src/main/ipc-system.js'), 'utf8');
    assert.ok(!ipcSysSrc.includes('ipcMain.handle("nbt:write"'), 'Le canal mort nbt:write doit être supprimé de ipc-system.js');
});

test('Audit remediations: save-horizon-settings persists syncMode & deltaCleanupThreshold, SettingsUI drops dead list action, ModsUI streams with hash, installers reports errors', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens_remediation_horizon_'));
    const horizonDir = path.join(tmpRoot, 'Horizon');
    await fs.promises.mkdir(horizonDir, { recursive: true });
    const setupHorizonHandlers = require('../src/main/ipc-horizon');
    const handlers = new Map();

    setupHorizonHandlers({
        ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
        safeDataDir: tmpRoot,
        horizonDir,
        mainLog: () => {},
        path,
        fs,
        crypto,
        spawn: () => {},
        app: { isPackaged: false, getVersion: () => '1.9.4' },
        horizonBinDir: horizonDir,
        horizonExePath: path.join(horizonDir, 'Horizon'),
        horizonVersionPath: path.join(horizonDir, 'horizon_version.json'),
        isWin: process.platform === 'win32',
        safeSend: () => {}
    });

    try {
        const saveRes = await handlers.get('save-horizon-settings')(null, {
            provider: 'dropbox',
            syncMode: 'FULL',
            deltaCleanupThreshold: 25,
            autoSync: false,
            autoUpload: 'false',
            systemEnabled: true,
            maxRetries: 4
        });
        assert.strictEqual(saveRes.success, true);

        const persisted = JSON.parse(await fs.promises.readFile(path.join(horizonDir, 'horizon_settings.json'), 'utf8'));
        assert.strictEqual(persisted.syncMode, 'FULL');
        assert.strictEqual(persisted.deltaCleanupThreshold, 25);
        assert.strictEqual(persisted.autoSync, false);
        assert.strictEqual(persisted.autoUpload, false);

        const badMode = await handlers.get('save-horizon-settings')(null, { syncMode: 'BOGUS' });
        assert.strictEqual(badMode.success, false);

        const badThreshold = await handlers.get('save-horizon-settings')(null, { deltaCleanupThreshold: 1 });
        assert.strictEqual(badThreshold.success, false);

        const settingsUiSrc = fs.readFileSync(path.resolve(__dirname, '../src/ui/SettingsUI.js'), 'utf8');
        assert.ok(settingsUiSrc.includes("ALLOWED_HORIZON_ACTIONS = ['sync', 'upload', 'quota', 'rollback']"), 'L action morte list doit être retirée de ALLOWED_HORIZON_ACTIONS');

        const modsUiSrc = fs.readFileSync(path.resolve(__dirname, '../src/ui/ModsUI.js'), 'utf8');
        assert.ok(modsUiSrc.includes('async function streamVerifiedAsset'), 'ModsUI doit mutualiser le streaming vérifié');
        assert.ok(modsUiSrc.includes('requireHash: true'), 'Modrinth .mrpack et mods doivent exiger une empreinte SHA');

        const installersSrc = fs.readFileSync(path.resolve(__dirname, '../src/local/installers.js'), 'utf8');
        const catchIdx = installersSrc.indexOf('} catch (/** @type {any} */ e) {');
        assert.ok(catchIdx !== -1, 'Bloc catch attendu dans installers.js');
        const catchBlock = installersSrc.slice(catchIdx, installersSrc.indexOf('executeModUpdates', catchIdx));
        assert.ok(!catchBlock.includes('msg_no_updates'), 'installers.js ne doit plus afficher msg_no_updates en cas d erreur dans le catch');
        assert.ok(catchBlock.includes('msg_err_dl'), 'installers.js doit signaler msg_err_dl en cas d erreur dans le catch');
    } finally {
        await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
});

test('Audit remediations: launch-game blocks concurrent pending launch, validateJavaExecutable requires bin/, and get-folder-size skips external symlinks', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens_remediation_sys_'));
    const sandboxDir = path.join(tmpRoot, 'sandbox');
    const externalDir = path.join(tmpRoot, 'external');
    await fs.promises.mkdir(sandboxDir, { recursive: true });
    await fs.promises.mkdir(externalDir, { recursive: true });

    const setupGameHandlers = require('../src/main/ipc-game');
    const setupSystemHandlers = require('../src/main/ipc-system');
    const assertPathUnderSandbox = createSandboxValidator(sandboxDir);

    const gameListeners = new Map();
    const gameHandlers = new Map();
    const sentEvents = [];
    setupGameHandlers({
        app: { getPath: () => tmpRoot },
        ipcMain: {
            handle: (ch, fn) => gameHandlers.set(ch, fn),
            on: (ch, fn) => gameListeners.set(ch, fn)
        },
        getMainWindow: () => ({
            isDestroyed: () => false,
            webContents: {
                isDestroyed: () => false,
                send: (ch, payload) => sentEvents.push({ ch, payload })
            }
        }),
        safeDataDir: sandboxDir,
        mainLog: () => {},
        path,
        fs,
        execFile: () => {},
        mainResolveInstanceFolder: (n) => n,
        safeSend: (_ev, ch, payload) => sentEvents.push({ ch, payload }),
        assertPathUnderSandbox
    });

    const sysHandlers = new Map();
    setupSystemHandlers({
        ipcMain: { handle: (ch, fn) => sysHandlers.set(ch, fn) },
        getMainWindow: () => null,
        mainLog: () => {},
        path,
        fs,
        execFile: () => {},
        assertPathUnderSandbox,
        sanitizeShortcutName: (n) => n,
        shell: {},
        app: { getPath: () => sandboxDir },
        safeDataDir: sandboxDir
    });

    try {
        // 1. validateJavaExecutable exige un répertoire parent bin/
        const nonBinJava = path.join(sandboxDir, 'java', 'jre17', process.platform === 'win32' ? 'java.exe' : 'java');
        await fs.promises.mkdir(path.dirname(nonBinJava), { recursive: true });
        await fs.promises.writeFile(nonBinJava, 'stub');
        const checkNonBin = await gameHandlers.get('check-java')({}, nonBinJava);
        assert.ok(checkNonBin.err, 'Un binaire Java hors dossier bin/ doit être bloqué');

        // 2. Concurrent launch-game sur la même instance est rejeté immédiatement via pendingLaunches
        const launchListener = gameListeners.get('launch-game');
        const binJava = path.join(sandboxDir, 'java', 'jre17', 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
        await fs.promises.mkdir(path.dirname(binJava), { recursive: true });
        await fs.promises.writeFile(binJava, 'stub');
        const instRoot = path.join(sandboxDir, 'instances', 'ConcurrentInst');
        await fs.promises.mkdir(instRoot, { recursive: true });

        const p1 = launchListener({ sender: { isDestroyed: () => false, send: (ch, payload) => sentEvents.push({ ch, payload }) } }, {
            instanceId: 'ConcurrentInst',
            authorization: { access_token: 'x', uuid: 'u', name: 'p', meta: {} },
            version: { number: '1.20.4', type: 'release' },
            root: instRoot,
            javaPath: binJava
        });
        const p2 = launchListener({ sender: { isDestroyed: () => false, send: (ch, payload) => sentEvents.push({ ch, payload }) } }, {
            instanceId: 'ConcurrentInst',
            authorization: { access_token: 'x', uuid: 'u', name: 'p', meta: {} },
            version: { number: '1.20.4', type: 'release' },
            root: instRoot,
            javaPath: binJava
        });
        await Promise.all([p1, p2]);
        assert.ok(sentEvents.some(e => e.ch === 'launch-game-rejected' && e.payload.reason === 'ALREADY_RUNNING'), 'Un double lancement concurrent doit être rejeté avec ALREADY_RUNNING');

        // 3. get-folder-size ignore les liens symboliques/jonctions pointant hors sandbox
        const extSecret = path.join(externalDir, 'huge.bin');
        await fs.promises.writeFile(extSecret, Buffer.alloc(4096, 0x41));
        const linkDir = path.join(instRoot, 'ext_link');
        let linked = false;
        try {
            await fs.promises.symlink(externalDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
            linked = true;
        } catch (_) {}
        if (linked) {
            const insideFile = path.join(instRoot, 'small.txt');
            await fs.promises.writeFile(insideFile, '12345');
            const sizeRes = await sysHandlers.get('get-folder-size')(null, instRoot);
            assert.strictEqual(sizeRes.success, true);
            assert.strictEqual(sizeRes.bytes, 5, 'get-folder-size doit ignorer la jonction/symlink externe');
        }
    } finally {
        await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
});

test('Audit remediations Lot 1-3: ipc-game blocks classpath/log4j/customLaunchArgs and batches mc-data floods', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens_audit_game_lot_'));
    const sandboxDir = path.join(tmpRoot, 'sandbox');
    const instRoot = path.join(sandboxDir, 'instances', 'AuditInst');
    const binJava = path.join(sandboxDir, 'java', 'jre21', 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    await fs.promises.mkdir(instRoot, { recursive: true });
    await fs.promises.mkdir(path.dirname(binJava), { recursive: true });
    await fs.promises.writeFile(binJava, 'stub');

    const { EventEmitter } = require('node:events');
    const Module = require('node:module');
    const assertPathUnderSandbox = createSandboxValidator(sandboxDir);
    const gameListeners = new Map();
    const gameHandlers = new Map();
    const sentEvents = [];

    setupGameHandlers({
        app: { getPath: () => tmpRoot },
        ipcMain: {
            handle: (ch, fn) => gameHandlers.set(ch, fn),
            on: (ch, fn) => gameListeners.set(ch, fn)
        },
        getMainWindow: () => ({
            isDestroyed: () => false,
            webContents: {
                isDestroyed: () => false,
                send: (ch, payload) => sentEvents.push({ ch, payload })
            }
        }),
        safeDataDir: sandboxDir,
        mainLog: () => {},
        path,
        fs,
        execFile: () => {},
        mainResolveInstanceFolder: (n) => n,
        safeSend: (_ev, ch, payload) => sentEvents.push({ ch, payload }),
        assertPathUnderSandbox
    });

    const launchListener = gameListeners.get('launch-game');
    const fakeEvent = {
        sender: {
            isDestroyed: () => false,
            send: (ch, payload) => sentEvents.push({ ch, payload })
        }
    };

    try {
        // 1. Blocage JVM args dangereux (-cp, -classpath, -Dlog4j*, -Xbootclasspath, -agentlib)
        for (const badJvm of [
            '-cp=evil.jar',
            '-classpath',
            '-Dlog4j.configurationFile=evil.xml',
            '-Dlog4j2.formatMsgNoLookups=false',
            '-Xbootclasspath/a:evil.jar',
            '-agentlib:jdwp'
        ]) {
            sentEvents.length = 0;
            await launchListener(fakeEvent, {
                instanceId: 'AuditInst',
                authorization: { access_token: 'secret-tok', uuid: 'u', name: 'p', meta: {} },
                version: { number: '1.20.4', type: 'release' },
                root: instRoot,
                javaPath: binJava,
                customArgs: [badJvm]
            });
            assert.ok(sentEvents.some(e => e.ch === 'mc-close' && e.payload.code === 1), `JVM flag ${badJvm} doit être bloqué`);
        }

        // 2. Blocage customLaunchArgs dangereux (--proxyPass, --accessToken, --gameDir)
        for (const badLaunch of [['--proxyPass', 'pw'], ['--accessToken=tok'], ['--gameDir', '/tmp']]) {
            sentEvents.length = 0;
            await launchListener(fakeEvent, {
                instanceId: 'AuditInst',
                authorization: { access_token: 'secret-tok', uuid: 'u', name: 'p', meta: {} },
                version: { number: '1.20.4', type: 'release' },
                root: instRoot,
                javaPath: binJava,
                customLaunchArgs: badLaunch
            });
            assert.ok(sentEvents.some(e => e.ch === 'mc-close' && e.payload.code === 1), `customLaunchArgs ${badLaunch[0]} doit être bloqué`);
        }

        // 3. Batching & anti-flood mc-data
        sentEvents.length = 0;
        const origLoad = Module._load;
        Module._load = function (request, parent, isMain) {
            if (request === '../gens-core/index.js') {
                class FakeClient extends EventEmitter {
                    async launch() {
                        const child = new EventEmitter();
                        child.pid = 999999;
                        setTimeout(() => {
                            for (let i = 0; i < 250; i++) {
                                this.emit('data', `log line ${i}\n`);
                            }
                            child.emit('close', 0);
                        }, 40);
                        return child;
                    }
                }
                return { Client: FakeClient };
            }
            return origLoad.apply(this, arguments);
        };
        try {
            await launchListener(fakeEvent, {
                instanceId: 'AuditInst',
                authorization: { access_token: 'secret-tok', uuid: 'u', name: 'p', meta: {} },
                version: { number: '1.20.4', type: 'release' },
                root: instRoot
            });
            await new Promise((r) => setTimeout(r, 150));
        } finally {
            Module._load = origLoad;
        }

        const dataEvents = sentEvents.filter(e => e.ch === 'mc-data');
        const closeIdx = sentEvents.findIndex(e => e.ch === 'mc-close');
        assert.ok(closeIdx !== -1, 'mc-close doit être émis');
        assert.ok(dataEvents.length >= 1 && dataEvents.length <= 5, `mc-data doit être batché (reçu ${dataEvents.length} événements pour 250 lignes)`);
        const combined = dataEvents.map(e => e.payload.data).join('');
        assert.ok(combined.includes('log line 0'), 'Le début du batch doit être flushé');
        assert.ok(combined.includes('ligne(s) ignorée(s) — flood JVM'), 'Le plafond anti-flood (200 lignes/batch) doit résumer les lignes excédentaires');
        const lastDataIdx = sentEvents.map(e => e.ch).lastIndexOf('mc-data');
        assert.ok(lastDataIdx < closeIdx, 'mc-data en attente doit être flushé avant mc-close');
    } finally {
        await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
});

test('Audit remediations Lot 1-3: ipc-horizon rejects unsigned version when packaged without keyring and guards concurrent install-horizon', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens_audit_horizon_lot_'));
    const horizonDir = path.join(tmpRoot, 'horizon');
    await fs.promises.mkdir(horizonDir, { recursive: true });
    const exePath = path.join(horizonDir, process.platform === 'win32' ? 'Horizon-win-amd64.exe' : 'Horizon-linux-amd64');
    const versionFile = path.join(horizonDir, 'horizon_version.json');
    await fs.promises.writeFile(exePath, 'stub');
    await fs.promises.writeFile(versionFile, JSON.stringify({ version: 'v1.0.0' }));

    const Module = require('node:module');
    const origLoad = Module._load;
    const origFetch = global.fetch;
    Module._load = function (request, parent, isMain) {
        if (request === 'electron') {
            return {
                safeStorage: {
                    isAsyncEncryptionAvailable: async () => false
                }
            };
        }
        return origLoad.apply(this, arguments);
    };

    let releaseFetchCalls = 0;
    const assetName = process.platform === 'win32' ? 'Horizon-win-amd64.exe' : 'Horizon-linux-amd64';
    global.fetch = async (url) => {
        const u = String(url);
        if (u.includes('api.github.com/repos/')) {
            releaseFetchCalls++;
            await new Promise((r) => setTimeout(r, 40));
        }
        return new Response(JSON.stringify({
            tag_name: 'v1.9.0',
            assets: [
                { name: assetName, browser_download_url: `https://github.com/WilliamBossard/Gens-Horizon/releases/download/v1.9.0/${assetName}` },
                { name: 'SHA256SUMS.txt', browser_download_url: 'https://evil.example.com/SHA256SUMS.txt' }
            ]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    try {
        const handlers = new Map();
        setupHorizonHandlers({
            ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
            safeDataDir: tmpRoot,
            horizonDir,
            mainLog: () => {},
            path,
            fs,
            crypto,
            spawn: () => {},
            app: { isPackaged: true, getVersion: () => '1.9.4' },
            horizonBinDir: horizonDir,
            horizonExePath: exePath,
            horizonVersionPath: versionFile,
            isWin: process.platform === 'win32',
            safeSend: () => {}
        });

        // 1. Trousseau indisponible en mode packagé => version locale non signée refusée
        const statusRes = await handlers.get('check-horizon-status')({}, true);
        assert.strictEqual(statusRes.localVersion, 'v0.0.0');
        assert.strictEqual(statusRes.needsUpdate, true);

        // 2. Garde single-flight sur install-horizon : 2 appels concurrents n'effectuent qu'un seul fetch release
        releaseFetchCalls = 0;
        const [r1, r2] = await Promise.all([
            handlers.get('install-horizon')({ sender: null }, false),
            handlers.get('install-horizon')({ sender: null }, false)
        ]);
        assert.strictEqual(releaseFetchCalls, 1, 'Les appels concurrents à install-horizon doivent partager le même vol');
        assert.deepStrictEqual(r1, r2);
    } finally {
        Module._load = origLoad;
        global.fetch = origFetch;
        await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
});

test('Audit remediations Lot 1-3: Handler.getLaunchOptions uses getAssetIndexNameAsync, DiscordRPC.getIpcPath is async, MCLCore honors abort, launchUI/InstancesUI checks', async () => {
    // 1. Handler.getLaunchOptions utilise getAssetIndexNameAsync() et non getAssetIndexName()
    const handler = new Handler({
        options: {
            root: os.tmpdir(),
            overrides: { gameDirectory: os.tmpdir() },
            authorization: { uuid: 'u', name: 'Player', access_token: 'tok', meta: {} },
            version: { number: '1.20.4', type: 'release' }
        },
        emit: () => {}
    });
    handler.version = {
        id: '1.20.4',
        type: 'release',
        assets: '1.20',
        minecraftArguments: '--username ${auth_player_name} --assetsDir ${assets_root} --assetIndex ${assets_index_name}'
    };
    handler.getAssetIndexName = () => { throw new Error('getAssetIndexName synchrone ne doit pas être appelé par getLaunchOptions'); };
    handler.getAssetIndexNameAsync = async () => '1.20-async-idx';
    const launchArgs = await handler.getLaunchOptions();
    const assetIdx = launchArgs.indexOf('--assetIndex');
    assert.ok(assetIdx !== -1 && launchArgs[assetIdx + 1] === '1.20-async-idx');

    // 2. DiscordRPC.getIpcPath est asynchrone
    const DiscordRPC = require('../src/gens-core/components/discord');
    const rpc = new DiscordRPC('0');
    const ipcPathPromise = rpc.getIpcPath(0);
    assert.ok(ipcPathPromise && typeof ipcPathPromise.then === 'function', 'getIpcPath doit retourner une Promise');
    const ipcPath = await ipcPathPromise;
    assert.ok(typeof ipcPath === 'string' && ipcPath.includes('discord-ipc-0'));

    // 3. MCLCore.startMinecraft refuse de spawner si abort() a déjà été appelé
    const MCLCore = require('../src/gens-core/components/launcher');
    const core = new MCLCore();
    core.abort();
    assert.throws(() => core.startMinecraft(['-version']), /Launch aborted by user/);

    // 4. Static regression checks for launchUI backup/upload gating & InstancesUI relaunch-app
    const launchUiSrc = fs.readFileSync(path.resolve(__dirname, '../src/launch/launchUI.js'), 'utf8');
    assert.ok(launchUiSrc.includes('if (closedInst && hadStartedSession)'), 'mc-close doit conditionner on_close backup et auto-upload à hadStartedSession');
    const instancesUiSrc = fs.readFileSync(path.resolve(__dirname, '../src/ui/InstancesUI.js'), 'utf8');
    assert.ok(instancesUiSrc.includes('window.api.send("relaunch-app")'), 'abortAutoLaunch doit envoyer relaunch-app');
    assert.ok(!instancesUiSrc.includes('"restart_app"'), 'Le canal mort restart_app ne doit plus être utilisé');
});

test('Audit remediations finale: shutdownHorizon graceful, assetIndex validation, updater/worlds/skin hardening', async () => {
    // 1. Handler bloque les traversées dans overrides.assetIndex
    const badHandler = new Handler({
        options: {
            root: os.tmpdir(),
            overrides: { gameDirectory: os.tmpdir(), assetIndex: '../evil' },
            authorization: { uuid: 'u', name: 'Player', access_token: 'tok', meta: {} },
            version: { number: '1.20.4', type: 'release' }
        },
        emit: () => {}
    });
    assert.throws(() => badHandler.getAssetIndexName(), /Invalid overrides\.assetIndex/);
    await assert.rejects(() => badHandler.getAssetIndexNameAsync(), /Invalid overrides\.assetIndex/);

    // 2. Régression statique des correctifs sur ipc-horizon, updater, SettingsUI, worlds, ModsUI, ipc-auth, AccountUI
    const ipcHorizonSrc = fs.readFileSync(path.resolve(__dirname, '../src/main/ipc-horizon.js'), 'utf8');
    assert.ok(ipcHorizonSrc.includes('windowsHide: true'), 'spawn Horizon doit masquer la fenêtre console Windows');
    const renameIdx = ipcHorizonSrc.indexOf('await renameWithRetry(tmpPath, targetExePath)');
    const cacheUpdateIdx = ipcHorizonSrc.indexOf('await updateGithubCache({ hash: expected');
    assert.ok(renameIdx !== -1 && cacheUpdateIdx > renameIdx, 'Le cache SHA256 doit être mis à jour après renameWithRetry');

    const updaterSrc = fs.readFileSync(path.resolve(__dirname, '../src/main/updater.js'), 'utf8');
    assert.ok(updaterSrc.includes('fs.promises.mkdtemp'), 'do-deb-update doit isoler la clé GPG avec mkdtemp');
    assert.ok(updaterSrc.includes('isDebPackageInstallation()'), 'updater doit vérifier les marqueurs .deb réels');

    const settingsUiSrc = fs.readFileSync(path.resolve(__dirname, '../src/ui/SettingsUI.js'), 'utf8');
    assert.ok(settingsUiSrc.includes('window.api.send("relaunch-app")'), 'startLauncherUpdate post-APT doit utiliser relaunch-app sans double pkexec');
    assert.ok(!settingsUiSrc.includes('https://api.adoptium.net/v3/binary/latest/'), 'downloadJavaAuto doit déduire URL+SHA256 depuis assets/latest uniquement');

    const worldsSrc = fs.readFileSync(path.resolve(__dirname, '../src/local/worlds.js'), 'utf8');
    assert.ok(worldsSrc.includes('store.activeInstances.has('), 'worlds.js doit refuser sauvegarde/suppression/restauration pendant exécution');
    assert.ok(worldsSrc.includes('_restore_old_'), 'restoreWorldBackup doit sauvegarder l ancien monde avant remplacement');

    const modsUiSrc = fs.readFileSync(path.resolve(__dirname, '../src/ui/ModsUI.js'), 'utf8');
    assert.ok(modsUiSrc.includes('v2/project/${encodeURIComponent(projectId)}/version'), 'ModsUI doit encoder projectId pour Modrinth');
    assert.ok(modsUiSrc.includes('v1/mods/${encodeURIComponent(projectId)}/files'), 'ModsUI doit encoder projectId pour CurseForge');
    assert.ok(modsUiSrc.includes('expectedHash: cfSha1'), 'ModsUI doit vérifier le SHA-1 CurseForge pour les modpacks');

    const ipcAuthSrc = fs.readFileSync(path.resolve(__dirname, '../src/main/ipc-auth.js'), 'utf8');
    assert.ok(ipcAuthSrc.includes('MAX_SKIN_BYTES'), 'fetch-mojang-raw-skin doit borner la taille de téléchargement');
    assert.ok(ipcAuthSrc.includes('renameWithRetry(tmpFile, destFile)'), 'login-microsoft doit utiliser renameWithRetry');

    const accountUiSrc = fs.readFileSync(path.resolve(__dirname, '../src/ui/AccountUI.js'), 'utf8');
    assert.ok(accountUiSrc.includes('file.size > 2 * 1024 * 1024'), 'uploadSkinToMojang doit contrôler file.size avant arrayBuffer()');
});
