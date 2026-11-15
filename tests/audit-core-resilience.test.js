const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');

const setupHorizonHandlers = require('../src/main/ipc-horizon');
const nbt = require('../src/gens-core/components/nbt');
const { pingServer } = require('../src/gens-core/components/ping');

test('launchCore blocks synced cloud javaPath located inside instancesRoot', async () => {
    const baseTmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens_audit_cloudjava_'));
    try {
        global.window = {
            api: {
                appData: baseTmp,
                platform: process.platform,
                fs: { promises: { readFile: fs.promises.readFile, writeFile: fs.promises.writeFile, mkdir: fs.promises.mkdir, access: fs.promises.access, readdir: fs.promises.readdir, stat: fs.promises.stat, unlink: fs.promises.unlink, rename: fs.promises.rename } },
                path,
                os,
            },
            safeDir: (name) => String(name || '').replace(/[^a-zA-Z0-9_\-]/g, '_'),
            existsSafe: async (p) => fs.promises.access(p).then(() => true).catch(() => false),
            safeWriteJSONAsync: async () => {},
            t: (_k, f) => f || _k,
            showToast: () => {},
        };
        const { store } = await import('../src/store.js');
        const { mergeInstanceConfigFromDisk } = await import('../src/launch/launchCore.js');
        store.instancesRoot = path.join(baseTmp, 'GensLauncher', 'instances');
        store.instanceFile = path.join(baseTmp, 'GensLauncher', 'instances.json');
        const instDir = path.join(store.instancesRoot, 'CloudInst');
        await fs.promises.mkdir(path.join(instDir, 'gens'), { recursive: true });
        const droppedJava = path.join(instDir, 'java.exe');
        await fs.promises.writeFile(droppedJava, 'MZ-FAKE');
        const inst = { name: 'CloudInst', version: '1.20.1', javaPath: '', _localConfigUpdatedAt: 100 };
        store.allInstances = [inst];
        await fs.promises.writeFile(
            path.join(instDir, 'gens', 'launcher_config.json'),
            JSON.stringify({ version: '1.20.1', javaPath: droppedJava, _cloudExportedAt: 5000 }),
            'utf8'
        );
        await mergeInstanceConfigFromDisk('CloudInst');
        assert.strictEqual(inst.javaPath, '', 'javaPath inside instancesRoot must never be accepted from cloud');
    } finally {
        delete global.window;
        await fs.promises.rm(baseTmp, { recursive: true, force: true });
    }
});

test('pingServer rejects immediately on premature TCP close without waiting for timeout', async () => {
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
        setImmediate(() => this.emit('close'));
        return true;
    };

    const start = Date.now();
    try {
        await assert.rejects(
            () => pingServer('127.0.0.1:25565', 5000),
            /closed prematurely/
        );
        assert.ok(Date.now() - start < 2000, 'pingServer must reject fast on clean close');
    } finally {
        net.Socket.prototype.connect = origConnect;
        net.Socket.prototype.write = origWrite;
        net.Socket.prototype.setTimeout = origSetTimeout;
        net.Socket.prototype.destroy = origDestroy;
    }
});

test('nbt.js rejects strings > 65535 UTF-8 bytes and Handler validates download URLs & case-insensitive SHA-1', async () => {
    const Handler = require('../src/gens-core/components/handler');
    const MCLCore = require('../src/gens-core/components/launcher');

    assert.throws(() => nbt.writeUncompressed({
        type: 'compound',
        name: '',
        value: { huge: { type: 'string', value: 'a'.repeat(65536) } }
    }), /RangeError|trop longue/);

    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens_audit_dl_'));
    try {
        const client = new MCLCore();
        const handler = new Handler(client);
        handler.options = { root: tmpDir, offline: false };
        const httpRes = await handler.downloadAsync('http://example.com/file.jar', tmpDir, 'file.jar', false, 'library');
        assert.strictEqual(httpRes.failed, true, 'Non-HTTPS URL must be blocked');
        const localRes = await handler.downloadAsync('https://127.0.0.1/file.jar', tmpDir, 'file.jar', false, 'library');
        assert.strictEqual(localRes.failed, true, 'Loopback HTTPS URL must be blocked');

        const f = path.join(tmpDir, 'hash.bin');
        await fs.promises.writeFile(f, 'abc');
        const sha1Upper = crypto.createHash('sha1').update('abc').digest('hex').toUpperCase();
        assert.strictEqual(await handler.checkSum(sha1Upper, f), true, 'checkSum must compare SHA-1 case-insensitively');
    } finally {
        await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
});

test('DiscordRPC applies exponential backoff and caps auto-reconnect attempts', () => {
    const DiscordRPC = require('../src/gens-core/components/discord');
    const rpc = new DiscordRPC('123456');
    const origSetTimeout = global.setTimeout;
    const delays = [];
    global.setTimeout = (fn, ms) => {
        delays.push(ms);
        return { unref() {} };
    };
    try {
        for (let i = 0; i < 12; i++) {
            rpc.reconnectTimer = null;
            rpc.scheduleReconnect();
        }
        assert.strictEqual(delays.length, 10, 'Auto-reconnect must stop after MAX_RECONNECT_ATTEMPTS (10)');
        assert.strictEqual(delays[0], 5000);
        assert.strictEqual(delays[1], 10000);
        assert.strictEqual(delays[9], 60000);
    } finally {
        global.setTimeout = origSetTimeout;
        rpc.disconnect();
    }
});

test('MCLCore.launch preserves spawnOptions.detached === false in overrides.detached', async () => {
    const Handler = require('../src/gens-core/components/handler');
    const MCLCore = require('../src/gens-core/components/launcher');
    const origCheckJava = Handler.prototype.checkJava;
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens_audit_detach_'));
    Handler.prototype.checkJava = async () => ({ run: false, message: 'stop-early-for-test' });
    try {
        const core = new MCLCore();
        await core.launch({
            root: tmpRoot,
            version: { number: '1.20.4', type: 'release' },
            spawnOptions: { detached: false },
        });
        assert.strictEqual(core.options.overrides.detached, false);

        const coreOverride = new MCLCore();
        await coreOverride.launch({
            root: tmpRoot,
            version: { number: '1.20.4', type: 'release' },
            spawnOptions: { detached: true },
            overrides: { detached: false },
        });
        assert.strictEqual(coreOverride.options.overrides.detached, false);
    } finally {
        Handler.prototype.checkJava = origCheckJava;
        await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
});

test('ipc-horizon check-horizon-status uses semver ordering so local v1.5.0 is not downgraded to v1.4.0', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens_audit_semver_'));
    const horizonDir = path.join(tmpRoot, 'Horizon');
    await fs.promises.mkdir(horizonDir, { recursive: true });
    await fs.promises.writeFile(path.join(horizonDir, 'horizon_version.json'), JSON.stringify({ version: 'v1.5.0' }));
    const handlers = new Map();
    setupHorizonHandlers({
        ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
        safeDataDir: tmpRoot,
        horizonDir,
        mainLog: () => {},
        path,
        fs,
        crypto,
        spawn: () => { throw new Error('unexpected spawn'); },
        app: { isPackaged: false, getVersion: () => '1.9.4' },
        horizonBinDir: horizonDir,
        horizonExePath: path.join(horizonDir, process.platform === 'win32' ? 'Horizon.exe' : 'Horizon'),
        horizonVersionPath: path.join(horizonDir, 'horizon_version.json'),
        isWin: process.platform === 'win32',
        safeSend: () => {},
    });
    const origFetch = global.fetch;
    global.fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({ tag_name: 'v1.4.0', assets: [] }),
    });
    try {
        const res = await handlers.get('check-horizon-status')({}, true);
        assert.strictEqual(res.localVersion, 'v1.5.0');
        assert.strictEqual(res.latestVersion, 'v1.4.0');
        assert.strictEqual(res.needsUpdate, false);
    } finally {
        global.fetch = origFetch;
        await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
});

test('nbt TAG_COMPOUND uses null-prototype objects and enforces write nesting depth', async () => {
    const nested = { type: 'compound', name: '', value: {} };
    let cursor = nested.value;
    cursor.hello = { type: 'string', value: 'world' };
    const decoded = await nbt.parse(nbt.writeUncompressed(nested));
    assert.strictEqual(Object.getPrototypeOf(decoded.parsed.value), null);
    assert.strictEqual('toString' in decoded.parsed.value, false);

    let deep = { type: 'compound', name: '', value: {} };
    let cur = deep.value;
    for (let i = 0; i < 520; i++) {
        cur.child = { type: 'compound', value: {} };
        cur = cur.child.value;
    }
    assert.throws(() => nbt.writeUncompressed(deep), /profondeur|depth/i);
});

test('jvm-utils parses 26.1-forge-62.1.0, filters bare natives-linux on arm64, and merges modification.arguments.game without mutation', async () => {
    const jvmUtils = require('../src/gens-core/components/jvm-utils');
    assert.deepStrictEqual(jvmUtils.parseVersion('26.1-forge-62.1.0'), { major: 26, minor: 1, patch: 0 });
    const origArchDesc = Object.getOwnPropertyDescriptor(process, 'arch');
    Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
    try {
        assert.strictEqual(
            jvmUtils.parseRule({ name: 'org.lwjgl:lwjgl:3.3.1:natives-linux' }, 'linux'),
            true,
            'bare :natives-linux must be skipped on arm64'
        );
    } finally {
        if (origArchDesc) Object.defineProperty(process, 'arch', origArchDesc);
    }

    const baseGameArgs = ['--username', '${auth_player_name}'];
    const version = { id: '1.21.4', arguments: { game: baseGameArgs } };
    const modification = { arguments: { game: ['--fml.forgeVersion', '49.0.1'] } };
    const built = await jvmUtils.buildLaunchOptions({
        version,
        modification,
        client: { emit: () => {} },
        isLegacy: false,
        assetIndexName: '1.21.4',
        quickPlayArgs: null,
        options: {
            root: os.tmpdir(),
            overrides: {},
            version: { number: '1.21.4', type: 'release' },
            authorization: { access_token: 'tok', name: 'Player', uuid: 'u1', user_properties: '{}', meta: { type: 'msa' } }
        }
    });
    assert.strictEqual(baseGameArgs.length, 2, 'version.arguments.game must not be mutated');
    assert.ok(built.includes('--fml.forgeVersion'));
});

test('pingServer sorts SRV records by priority/weight, preserves originalHost, and blocks private SRV target', async () => {
    const dns = require('dns');
    const origResolveSrv = dns.resolveSrv;
    const origConnect = net.Socket.prototype.connect;
    const origWrite = net.Socket.prototype.write;
    const origSetTimeout = net.Socket.prototype.setTimeout;
    const origDestroy = net.Socket.prototype.destroy;
    const isStdio = (s) => s === process.stdout || s === process.stderr;
    try {
        dns.resolveSrv = (_name, cb) => cb(null, [
            { priority: 20, weight: 100, port: 25566, name: 'backup.example.org.' },
            { priority: 10, weight: 50, port: 25570, name: 'primary.example.org.' },
            { priority: 10, weight: 5, port: 25571, name: 'lowweight.example.org.' }
        ]);
        let connected = null;
        let capturedHandshake = null;
        net.Socket.prototype.setTimeout = function () { return isStdio(this) ? origSetTimeout.apply(this, arguments) : this; };
        net.Socket.prototype.destroy = function () { return isStdio(this) ? origDestroy.apply(this, arguments) : this; };
        net.Socket.prototype.connect = function (port, host, cb) {
            if (isStdio(this)) return origConnect.apply(this, arguments);
            connected = { host, port };
            if (typeof cb === 'function') setImmediate(cb);
            return this;
        };
        net.Socket.prototype.write = function (buf) {
            if (isStdio(this)) return origWrite.apply(this, arguments);
            if (!capturedHandshake) capturedHandshake = Buffer.from(buf);
            setImmediate(() => this.emit('close'));
            return true;
        };
        await assert.rejects(() => pingServer('play.example.org', 2000), /closed prematurely/);
        assert.deepStrictEqual(connected, { host: 'primary.example.org', port: 25570 });
        assert.ok(capturedHandshake && capturedHandshake.includes(Buffer.from('play.example.org')));

        dns.resolveSrv = (_name, cb) => cb(null, [{ priority: 10, weight: 10, port: 25565, name: '127.0.0.1.' }]);
        await assert.rejects(() => pingServer('evil-srv.example.org', 2000), /bloqué|private|local|SRV/i);
    } finally {
        dns.resolveSrv = origResolveSrv;
        net.Socket.prototype.connect = origConnect;
        net.Socket.prototype.write = origWrite;
        net.Socket.prototype.setTimeout = origSetTimeout;
        net.Socket.prototype.destroy = origDestroy;
    }
});

test('MicrosoftAuth flowRefresh keeps existing refresh_token when omitted and cancel aborts polling immediately', async () => {
    const MicrosoftAuth = require('../src/gens-core/components/auth');
    const auth = new MicrosoftAuth();
    auth.refreshMsaToken = async () => ({ access_token: 'new-msa' });
    auth.exchangeTokens = async (msa, refresh) => ({ mcToken: msa, profile: { name: 'P', id: '1' }, msaRefreshToken: refresh });
    const refreshed = await auth.flowRefresh('old-refresh-token');
    assert.strictEqual(refreshed.msaRefreshToken, 'old-refresh-token');

    const authCancel = new MicrosoftAuth();
    authCancel._fetchWithTimeout = async () => ({
        json: async () => ({ error: 'authorization_pending' })
    });
    const pollPromise = authCancel.pollDeviceCode('dev-code', 60);
    setTimeout(() => authCancel.cancel(), 15);
    await assert.rejects(() => pollPromise, /cancelled/i);
});

test('DiscordRPC handleData answers PING (opcode 3) with PONG (opcode 4) and destroys socket on CLOSE (opcode 2)', () => {
    const DiscordRPC = require('../src/gens-core/components/discord');
    const rpc = new DiscordRPC('123456');
    const sent = [];
    let destroyed = false;
    rpc.socket = {
        destroyed: false,
        write: (pkt) => sent.push(Buffer.from(pkt)),
        destroy: () => { destroyed = true; }
    };

    const pingPayload = Buffer.from(JSON.stringify({ nonce: 'n1' }), 'utf8');
    const pingFrame = Buffer.alloc(8 + pingPayload.length);
    pingFrame.writeInt32LE(3, 0);
    pingFrame.writeInt32LE(pingPayload.length, 4);
    pingPayload.copy(pingFrame, 8);
    rpc.handleData(pingFrame);

    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].readInt32LE(0), 4);
    assert.deepStrictEqual(JSON.parse(sent[0].subarray(8).toString('utf8')), { nonce: 'n1' });

    const closeFrame = Buffer.alloc(8);
    closeFrame.writeInt32LE(2, 0);
    closeFrame.writeInt32LE(0, 4);
    rpc.handleData(closeFrame);
    assert.strictEqual(destroyed, true);
});

test('DiscordRPC handleData reassembles fragmented IPC frames and rejects oversized length', () => {
    const DiscordRPC = require('../src/gens-core/components/discord');
    const rpc = new DiscordRPC('123456');
    const sent = [];
    let destroyed = false;
    rpc.socket = {
        destroyed: false,
        write: (pkt) => sent.push(Buffer.from(pkt)),
        destroy: () => { destroyed = true; rpc.socket.destroyed = true; }
    };

    const payload1 = Buffer.from(JSON.stringify({ nonce: 'frag-1' }), 'utf8');
    const frame1 = Buffer.alloc(8 + payload1.length);
    frame1.writeInt32LE(3, 0);
    frame1.writeInt32LE(payload1.length, 4);
    payload1.copy(frame1, 8);

    const payload2 = Buffer.from(JSON.stringify({ nonce: 'frag-2' }), 'utf8');
    const frame2 = Buffer.alloc(8 + payload2.length);
    frame2.writeInt32LE(3, 0);
    frame2.writeInt32LE(payload2.length, 4);
    payload2.copy(frame2, 8);

    const combined = Buffer.concat([frame1, frame2]);
    // 1er chunk : moitié du header (< 8 octets)
    rpc.handleData(combined.subarray(0, 4));
    assert.strictEqual(sent.length, 0);
    // 2e chunk : reste du 1er header + moitié du payload1
    rpc.handleData(combined.subarray(4, 12));
    assert.strictEqual(sent.length, 0);
    // 3e chunk : fin de frame1 + toute la frame2 d'un coup
    rpc.handleData(combined.subarray(12));

    assert.strictEqual(sent.length, 2);
    assert.deepStrictEqual(JSON.parse(sent[0].subarray(8).toString('utf8')), { nonce: 'frag-1' });
    assert.deepStrictEqual(JSON.parse(sent[1].subarray(8).toString('utf8')), { nonce: 'frag-2' });
    assert.strictEqual(rpc._rxBuffer.length, 0);

    // En-tête malveillant > 1 Mo -> destruction socket & reset buffer
    const badHeader = Buffer.alloc(8);
    badHeader.writeInt32LE(3, 0);
    badHeader.writeInt32LE(50 * 1024 * 1024, 4);
    rpc.handleData(badHeader);
    assert.strictEqual(destroyed, true);
    assert.strictEqual(rpc._rxBuffer.length, 0);
});


