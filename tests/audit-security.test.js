const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');

const { createSandboxValidator } = require('../src/main/fs-utils');
const setupFsHandlers = require('../src/main/ipc-fs');
const setupHorizonHandlers = require('../src/main/ipc-horizon');
const nbt = require('../src/gens-core/components/nbt');
const { pingServer } = require('../src/gens-core/components/ping');
const { openZip, writeZipFromFiles } = require('../src/main/zip-utils');
const afterPackLinuxSandbox = require('../build/afterPackLinuxSandbox').default;

test('ipc-fs blocks arbitrary extensions outside sandbox, restricts java.exe to stat/exists/access, and blocks symlink escape', async () => {
        const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens_audit_fs_'));
        const sandboxDir = path.join(tmpRoot, 'sandbox');
        const outsideDir = path.join(tmpRoot, 'outside');
        await fs.promises.mkdir(sandboxDir, { recursive: true });
        await fs.promises.mkdir(outsideDir, { recursive: true });

        const secretPng = path.join(outsideDir, 'secret.png');
        await fs.promises.writeFile(secretPng, 'not-public-png');

        const fakeJavaExe = path.join(outsideDir, 'java.exe');
        await fs.promises.writeFile(fakeJavaExe, 'MZ');

        const junctionInSandbox = path.join(sandboxDir, 'escape_link');
        let symlinkCreated = false;
        try {
            await fs.promises.symlink(outsideDir, junctionInSandbox, process.platform === 'win32' ? 'junction' : 'dir');
            symlinkCreated = true;
        } catch (_) {
            // Sur certains environnements restreints, symlink peut échouer sans privilèges
        }

        const handlers = new Map();
        setupFsHandlers({
            ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
            safeDataDir: sandboxDir,
            mainLog: () => {},
            path,
            fs,
            os,
            app: {
                getPath: (name) => (name === 'appData' ? sandboxDir : os.tmpdir()),
                getAppPath: () => path.resolve(__dirname, '..'),
            },
            assertPathUnderSandbox: createSandboxValidator(sandboxDir),
        });

        // 1. Plus de contournement par extension .png hors sandbox
        const readPngRes = await handlers.get('fs:readFile')(null, secretPng, 'utf8');
        assert.strictEqual(readPngRes.ok, false);
        assert.strictEqual(readPngRes.error.code, 'EACCES');

        // 2. java.exe hors sandbox autorisé pour stat/exists/access, MAIS bloqué en lecture de contenu
        const javaExists = await handlers.get('fs:exists')(null, fakeJavaExe);
        assert.strictEqual(javaExists.ok, true);
        assert.strictEqual(javaExists.data, true);

        const javaStat = await handlers.get('fs:stat')(null, fakeJavaExe);
        assert.strictEqual(javaStat.ok, true);
        assert.strictEqual(javaStat.data.isFile, true);

        const javaRead = await handlers.get('fs:readFile')(null, fakeJavaExe, 'utf8');
        assert.strictEqual(javaRead.ok, false);
        assert.strictEqual(javaRead.error.code, 'EACCES');

        // 3. Symlink/junction sortant du sandbox bloqué à la lecture
        if (symlinkCreated) {
            const escapedRead = await handlers.get('fs:readFile')(null, path.join(junctionInSandbox, 'secret.png'), 'utf8');
            assert.strictEqual(escapedRead.ok, false);
            assert.strictEqual(escapedRead.error.code, 'EACCES');
        }

        await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    });

test('nbt.parse rejects oversized array counts, truncated strings, and excessive nesting depth', async () => {
        // Compound root ("") avec une entrée TAG_Byte_Array déclarant 0x7FFFFFFF octets
        const oversizedByteArray = Buffer.concat([
            Buffer.from([0x0a, 0x00, 0x00]), // TAG_Compound ""
            Buffer.from([0x07, 0x00, 0x01, 0x61]), // TAG_Byte_Array "a"
            Buffer.from([0x7f, 0xff, 0xff, 0xff]), // length = 2147483647
            Buffer.from([0x00]),
        ]);
        await assert.rejects(() => nbt.parse(oversizedByteArray), /exceeds remaining buffer/);

        // Longueur négative
        const negativeLen = Buffer.concat([
            Buffer.from([0x0a, 0x00, 0x00]),
            Buffer.from([0x0b, 0x00, 0x01, 0x62]), // TAG_Int_Array "b"
            Buffer.from([0xff, 0xff, 0xff, 0xff]), // -1
            Buffer.from([0x00]),
        ]);
        await assert.rejects(() => nbt.parse(negativeLen), /Invalid negative length/);

        // Profondeur > 64 TAG_Compound imbriqués
        const chunks = [Buffer.from([0x0a, 0x00, 0x00])];
        for (let i = 0; i < 66; i++) {
            chunks.push(Buffer.from([0x0a, 0x00, 0x01, 0x78]));
        }
        for (let i = 0; i < 67; i++) {
            chunks.push(Buffer.from([0x00]));
        }
        await assert.rejects(() => nbt.parse(Buffer.concat(chunks)), /maximum nesting depth/);
    });

test('pingServer rejects oversized server responses > 2 MiB', async () => {
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
            setImmediate(() => {
                // VarInt(2000000) = [0x80, 0x89, 0x7a] passe le contrôle packetLength (<= 2 MiB),
                // puis le 2e chunk dépasse MAX_PING_BYTES (2 MiB).
                const chunk1 = Buffer.alloc(1500000, 0x41);
                chunk1[0] = 0x80;
                chunk1[1] = 0x89;
                chunk1[2] = 0x7a;
                const chunk2 = Buffer.alloc(1000000, 0x41);
                this.emit('data', chunk1);
                this.emit('data', chunk2);
            });
            return true;
        };

        try {
            await assert.rejects(() => pingServer('127.0.0.1:25565', 3000), /Response too large/);
        } finally {
            net.Socket.prototype.connect = origConnect;
            net.Socket.prototype.write = origWrite;
            net.Socket.prototype.setTimeout = origSetTimeout;
            net.Socket.prototype.destroy = origDestroy;
        }
    });

test('ipc-horizon enforces SHA-256 fail-closed when packaged and allows dev binary when unpackaged', async () => {
        const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens_audit_horizon_'));
        const horizonDir = path.join(tmpRoot, 'Horizon');
        await fs.promises.mkdir(horizonDir, { recursive: true });

        const binName = process.platform === 'win32' ? 'Horizon.exe' : 'Horizon';
        const exePath = path.join(horizonDir, binName);
        await fs.promises.writeFile(exePath, 'fake-dev-binary');

        // 1. Mode packagé sans hash attendu en cache ni réseau -> doit refuser l'exécution
        const packagedHandlers = new Map();
        const sentEvents = [];
        setupHorizonHandlers({
            ipcMain: { handle: (ch, fn) => packagedHandlers.set(ch, fn) },
            safeDataDir: tmpRoot,
            horizonDir,
            mainLog: () => {},
            path,
            fs,
            crypto,
            spawn: () => { throw new Error('spawn must not be called when packaged without SHA-256'); },
            app: { isPackaged: true, getVersion: () => '1.9.3' },
            horizonBinDir: horizonDir,
            horizonExePath: exePath,
            horizonVersionPath: path.join(horizonDir, 'horizon_version.json'),
            isWin: process.platform === 'win32',
            safeSend: (_ev, ch, payload) => sentEvents.push({ ch, payload }),
        });

        const originalFetch = global.fetch;
        global.fetch = async () => { throw new Error('offline test'); };
        try {
            const res = await packagedHandlers.get('call-horizon')({}, ['--status']);
            assert.strictEqual(res.exitCode, -1);
            assert.ok(sentEvents.some(e => e.payload && e.payload.type === 'ERROR'));

            // 2. Mode dev (!app.isPackaged) -> doit laisser spawner le binaire local même sans hash
            let spawnedCmd = null;
            const devHandlers = new Map();
            setupHorizonHandlers({
                ipcMain: { handle: (ch, fn) => devHandlers.set(ch, fn) },
                safeDataDir: tmpRoot,
                horizonDir,
                mainLog: () => {},
                path,
                fs,
                crypto,
                spawn: (cmd) => {
                    spawnedCmd = cmd;
                    const EventEmitter = require('node:events');
                    const child = new EventEmitter();
                    child.stdout = new EventEmitter();
                    child.stderr = new EventEmitter();
                    setImmediate(() => child.emit('close', 0));
                    return child;
                },
                app: { isPackaged: false, getVersion: () => '1.9.3' },
                horizonBinDir: horizonDir,
                horizonExePath: exePath,
                horizonVersionPath: path.join(horizonDir, 'horizon_version.json'),
                isWin: process.platform === 'win32',
                safeSend: () => {},
            });

            const devRes = await devHandlers.get('call-horizon')({}, ['--status']);
            assert.strictEqual(devRes.exitCode, 0);
            assert.strictEqual(spawnedCmd, exePath);
        } finally {
            global.fetch = originalFetch;
            await fs.promises.rm(tmpRoot, { recursive: true, force: true });
        }
    });

test('afterPackLinuxSandbox generates unshare probe wrapper for Linux builds only', async () => {
        const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens_audit_afterpack_'));
        const exePath = path.join(tmpDir, 'gens-launcher');
        await fs.promises.writeFile(exePath, 'ELF-BINARY');

        await afterPackLinuxSandbox({
            electronPlatformName: 'win32',
            appOutDir: tmpDir,
            packager: { executableName: 'gens-launcher' },
        });
        assert.strictEqual(fs.existsSync(path.join(tmpDir, 'gens-launcher.bin')), false);

        await afterPackLinuxSandbox({
            electronPlatformName: 'linux',
            appOutDir: tmpDir,
            packager: { executableName: 'gens-launcher' },
        });
        assert.strictEqual(fs.existsSync(path.join(tmpDir, 'gens-launcher.bin')), true);
        const wrapperContent = await fs.promises.readFile(exePath, 'utf8');
        assert.ok(wrapperContent.includes('unshare --user'));
        assert.ok(wrapperContent.includes('--is-appimage'));
        assert.ok(wrapperContent.includes('--no-sandbox'));

        await fs.promises.rm(tmpDir, { recursive: true, force: true });
    });

test('zip-utils pure-Node round-trip (UTF-8, Store, Deflate) et détection CRC-32 / troncature', async () => {
        const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens_audit_ziputils_'));
        const srcDir = path.join(tmpDir, 'src');
        await fs.promises.mkdir(srcDir, { recursive: true });

        const textFile = path.join(srcDir, 'config_été.txt');
        const emptyFile = path.join(srcDir, 'empty.txt');
        const pngFile = path.join(srcDir, 'icon.png');
        const largeFile = path.join(srcDir, 'large_batch.bin');
        await fs.promises.writeFile(textFile, 'Contenu accentué à compresser en Deflate ! '.repeat(20), 'utf8');
        await fs.promises.writeFile(emptyFile, Buffer.alloc(0));
        await fs.promises.writeFile(pngFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        // > 256 Ko pour tester le batching multi-chunks et la vérification CRC-32/taille exacte
        const largePayload = Buffer.alloc(320 * 1024);
        for (let i = 0; i < largePayload.length; i++) largePayload[i] = (i * 31) & 0xff;
        await fs.promises.writeFile(largeFile, largePayload);

        const zipPath = path.join(tmpDir, 'out.zip');
        let progressCalls = 0;
        await writeZipFromFiles(zipPath, [
            { fullPath: textFile, relativePath: 'config_été.txt' },
            { fullPath: emptyFile, relativePath: 'empty.txt' },
            { fullPath: pngFile, relativePath: 'nested\\icon.png' },
            { fullPath: largeFile, relativePath: 'large_batch.bin' }
        ], {
            level: 6,
            onProgress: () => { progressCalls++; }
        });
        assert.strictEqual(progressCalls, 4);

        const reader = await openZip(zipPath);
        const entries = new Map();
        try {
            assert.strictEqual(reader.entryCount, 4);
            for await (const entry of reader) {
                const rs = await entry.openReadStream();
                const chunks = [];
                for await (const c of rs) chunks.push(c);
                entries.set(entry.filename, {
                    method: entry.compressionMethod,
                    buf: Buffer.concat(chunks)
                });
            }
        } finally {
            await reader.close();
        }

        assert.strictEqual(entries.get('config_été.txt')?.method, 8);
        assert.strictEqual(entries.get('config_été.txt')?.buf.toString('utf8'), 'Contenu accentué à compresser en Deflate ! '.repeat(20));
        assert.strictEqual(entries.get('empty.txt')?.method, 0);
        assert.strictEqual(entries.get('empty.txt')?.buf.length, 0);
        assert.strictEqual(entries.get('nested/icon.png')?.method, 0);
        assert.strictEqual(entries.get('nested/icon.png')?.buf.length, 8);
        assert.strictEqual(Buffer.compare(entries.get('large_batch.bin')?.buf, largePayload), 0);

        // Destruction anticipée du flux d'entrée sans erreur ni blocage
        const earlyReader = await openZip(zipPath);
        try {
            for await (const entry of earlyReader) {
                if (entry.filename === 'large_batch.bin') {
                    const rs = await entry.openReadStream();
                    rs.destroy();
                    break;
                }
            }
        } finally {
            await earlyReader.close();
        }

        // Protection anti Zip Bomb : taille déclarée dans le Central Directory falsifiée (plus petite que le flux réel)
        const forgedBuf = await fs.promises.readFile(zipPath);
        const cdSigOffset = forgedBuf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
        assert.ok(cdSigOffset > 0, 'Central Directory introuvable');
        forgedBuf.writeUInt32LE(4, cdSigOffset + 24); // uncompressedSize falsifiée = 4 octets pour config_été.txt
        const forgedZipPath = path.join(tmpDir, 'forged_size.zip');
        await fs.promises.writeFile(forgedZipPath, forgedBuf);

        const forgedReader = await openZip(forgedZipPath);
        try {
            await assert.rejects(async () => {
                for await (const entry of forgedReader) {
                    if (entry.filename === 'config_été.txt') {
                        const rs = await entry.openReadStream();
                        for await (const _ of rs) { /* consume */ }
                    }
                }
            }, /Taille décompressée supérieure à la taille déclarée/);
        } finally {
            await forgedReader.close();
        }

        // Altération d'un octet dans les données Store (icon.png) pour déclencher une erreur CRC-32 explicite
        const rawZip = await fs.promises.readFile(zipPath);
        const pngMagicOffset = rawZip.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        assert.ok(pngMagicOffset > 0, 'signature PNG Store introuvable dans le ZIP');
        rawZip[pngMagicOffset + 2] ^= 0xff;
        const corruptZipPath = path.join(tmpDir, 'corrupt.zip');
        await fs.promises.writeFile(corruptZipPath, rawZip);

        const corruptReader = await openZip(corruptZipPath);
        try {
            await assert.rejects(async () => {
                for await (const entry of corruptReader) {
                    if (entry.filename === 'nested/icon.png') {
                        const rs = await entry.openReadStream();
                        for await (const _ of rs) { /* consume */ }
                    }
                }
            }, /CRC-32 invalide/);
        } finally {
            await corruptReader.close();
        }

        // Archive tronquée -> doit rejeter proprement
        const truncZipPath = path.join(tmpDir, 'trunc.zip');
        await fs.promises.writeFile(truncZipPath, rawZip.subarray(0, 12));
        await assert.rejects(() => openZip(truncZipPath), /trop petit|invalide/);

        await fs.promises.rm(tmpDir, { recursive: true, force: true });
    });

test('ipc-game launch-game blocks out-of-sandbox overrides, non-HTTPS URLs, and dangerous JVM args', async () => {
        const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens_game_sec_'));
        const sandboxDir = path.join(tmpRoot, 'sandbox');
        const outsideDir = path.join(tmpRoot, 'outside');
        await fs.promises.mkdir(sandboxDir, { recursive: true });
        await fs.promises.mkdir(outsideDir, { recursive: true });

        const setupGameHandlers = require('../src/main/ipc-game');
        const assertPathUnderSandbox = createSandboxValidator(sandboxDir);
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

        // 1. overrides.minecraftJar hors sandbox -> rejeté avec code 1
        await launchListener({}, {
            instanceId: 'inst-override',
            authorization: { access_token: 'x', uuid: 'u', name: 'p', meta: {} },
            version: { number: '1.20.4', type: 'release' },
            root: path.join(sandboxDir, 'instances', 'inst-override'),
            overrides: { minecraftJar: path.join(outsideDir, 'evil.jar') }
        });
        assert.ok(sentEvents.some(e => e.ch === 'mc-close' && e.payload.instanceId === 'inst-override' && e.payload.code === 1));

        // 2. customArgs dangereux (-javaagent) -> rejeté avec code 1
        sentEvents.length = 0;
        await launchListener({}, {
            instanceId: 'inst-jvm',
            authorization: { access_token: 'x', uuid: 'u', name: 'p', meta: {} },
            version: { number: '1.20.4', type: 'release' },
            root: path.join(sandboxDir, 'instances', 'inst-jvm'),
            customArgs: ['-Xmx2G', '-javaagent:C:\\evil.jar']
        });
        assert.ok(sentEvents.some(e => e.ch === 'mc-close' && e.payload.instanceId === 'inst-jvm' && e.payload.code === 1));

        // 3. overrides.url non HTTPS -> rejeté avec code 1
        sentEvents.length = 0;
        await launchListener({}, {
            instanceId: 'inst-url',
            authorization: { access_token: 'x', uuid: 'u', name: 'p', meta: {} },
            version: { number: '1.20.4', type: 'release' },
            root: path.join(sandboxDir, 'instances', 'inst-url'),
            overrides: { url: { meta: 'http://insecure.example.com' } }
        });
        assert.ok(sentEvents.some(e => e.ch === 'mc-close' && e.payload.instanceId === 'inst-url' && e.payload.code === 1));

        // 4. javaPath dans un dossier d'instance -> rejeté avec code 1
        const fakeInstanceJava = path.join(sandboxDir, 'instances', 'inst-java', 'java.exe');
        await fs.promises.mkdir(path.dirname(fakeInstanceJava), { recursive: true });
        await fs.promises.writeFile(fakeInstanceJava, 'MZ');
        sentEvents.length = 0;
        await launchListener({}, {
            instanceId: 'inst-java',
            authorization: { access_token: 'x', uuid: 'u', name: 'p', meta: {} },
            version: { number: '1.20.4', type: 'release' },
            root: path.join(sandboxDir, 'instances', 'inst-java'),
            javaPath: fakeInstanceJava,
        });
        assert.ok(sentEvents.some(e => e.ch === 'mc-close' && e.payload.instanceId === 'inst-java' && e.payload.code === 1));

        await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    });

test('ipc-fs fs:cp enforces dereference:false and blocks symlinks', async () => {
        const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens_cp_sec_'));
        const sandboxDir = path.join(tmpRoot, 'sandbox');
        const outsideFile = path.join(tmpRoot, 'secret.txt');
        await fs.promises.mkdir(sandboxDir, { recursive: true });
        await fs.promises.writeFile(outsideFile, 'top-secret');

        const symlinkPath = path.join(sandboxDir, 'link.txt');
        let symlinkOk = false;
        try {
            await fs.promises.symlink(outsideFile, symlinkPath, 'file');
            symlinkOk = true;
        } catch (_) {}

        if (symlinkOk) {
            const handlers = new Map();
            setupFsHandlers({
                ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
                safeDataDir: sandboxDir,
                mainLog: () => {},
                path,
                fs,
                os,
                app: { getAppPath: () => sandboxDir, getPath: () => tmpRoot },
                assertPathUnderSandbox: createSandboxValidator(sandboxDir)
            });
            const cpRes = await handlers.get('fs:cp')({}, path.join(sandboxDir, 'link.txt'), path.join(sandboxDir, 'copied.txt'), { dereference: true });
            assert.strictEqual(cpRes.ok, false, 'fs:cp ne doit pas suivre ou copier un symlink même avec dereference:true');
            assert.strictEqual(fs.existsSync(path.join(sandboxDir, 'copied.txt')), false);
        }

        await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    });

test('Handler fastSizeOnly, offline no-network mode, and pure getLaunchOptions rules', async () => {
        const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens_handler_sec_'));
        const Handler = require('../src/gens-core/components/handler');
        const EventEmitter = require('events');

        const dummyFile = path.join(tmpRoot, 'asset.bin');
        await fs.promises.writeFile(dummyFile, Buffer.alloc(64, 0x41));

        // 1. fastSizeOnly=true court-circuite le SHA-1 si la taille correspond
        const fastClient = Object.assign(new EventEmitter(), {
            options: {
                root: tmpRoot,
                fastSizeOnly: true,
                offline: false,
                overrides: { url: {} },
                version: { number: '1.20.4', type: 'release' }
            }
        });
        const fastHandler = new Handler(fastClient);
        assert.strictEqual(await fastHandler.verifyFileFast(dummyFile, 64, '0000000000000000000000000000000000000000'), true);
        assert.strictEqual(await fastHandler.verifyFileFast(dummyFile, 65, '0000000000000000000000000000000000000000'), false);

        // 2. Mode offline: getVersion rejette sans appeler fetch()
        const origFetch = global.fetch;
        let fetchCalled = false;
        global.fetch = async () => { fetchCalled = true; throw new Error('Should not call fetch offline'); };
        try {
            const offlineClient = Object.assign(new EventEmitter(), {
                options: {
                    root: tmpRoot,
                    directory: path.join(tmpRoot, 'versions', '1.20.4'),
                    offline: true,
                    overrides: { url: {} },
                    version: { number: '1.20.4', type: 'release' },
                    authorization: { access_token: '0', name: 'Steve', uuid: 'u', user_properties: '{}', meta: { type: 'legacy' } }
                }
            });
            const offlineHandler = new Handler(offlineClient);
            await assert.rejects(() => offlineHandler.getVersion(), /hors-ligne/);
            assert.strictEqual(fetchCalled, false, 'Aucun appel réseau ne doit avoir lieu en mode offline');
        } finally {
            global.fetch = origFetch;
        }

        // 3. getLaunchOptions évalue correctement les règles features sans muter l'ordre/contenu
        const ruleClient = Object.assign(new EventEmitter(), {
            options: {
                root: tmpRoot,
                directory: path.join(tmpRoot, 'versions', '1.20.4'),
                features: ['is_demo_user'],
                overrides: { url: {} },
                version: { number: '1.20.4', type: 'release' },
                authorization: { access_token: 'tok', name: 'Player', uuid: 'uuid-1', user_properties: '{}', meta: { type: 'msa', demo: false } }
            }
        });
        const ruleHandler = new Handler(ruleClient);
        ruleHandler.version = {
            id: '1.20.4',
            assetIndex: { id: '12' },
            arguments: {
                game: [
                    '--username', '${auth_player_name}',
                    { rules: [{ action: 'allow', features: { is_demo_user: true } }], value: ['--demo-flag'] },
                    { rules: [{ action: 'allow', features: { has_custom_resolution: true } }], value: ['--width', '800'] }
                ]
            }
        };
        const launchArgs = await ruleHandler.getLaunchOptions();
        assert.ok(launchArgs.includes('--username'));
        assert.ok(launchArgs.includes('Player'));
        assert.ok(launchArgs.includes('--demo-flag'), 'La feature activée doit être incluse');
        assert.ok(!launchArgs.includes('--width'), 'La feature non activée ne doit pas être incluse');

        await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    });

test('ipc-system copy-file-to-sandbox, duplicate-instance-folder and get-folder-size enforce security and return accurate sizes', async () => {
        const tmpRoot = await fs.promises.mkdtemp(path.join(await fs.promises.realpath(os.tmpdir()), 'gens_audit_sys_'));
        const sandboxDir = path.join(tmpRoot, 'sandbox');
        const externalDir = path.join(tmpRoot, 'external');
        await fs.promises.mkdir(sandboxDir, { recursive: true });
        await fs.promises.mkdir(externalDir, { recursive: true });

        const handlers = new Map();
        const setupSystemHandlers = require('../src/main/ipc-system');
        setupSystemHandlers({
            ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
            getMainWindow: () => null,
            mainLog: () => {},
            path,
            fs,
            execFile: () => {},
            assertPathUnderSandbox: createSandboxValidator(sandboxDir),
            sanitizeShortcutName: (n) => n,
            shell: {},
            app: { getPath: () => sandboxDir },
            safeDataDir: sandboxDir,
        });

        const secretJson = path.join(externalDir, 'secret.json');
        await fs.promises.writeFile(secretJson, '{"token":"abc"}');
        const fakeZip = path.join(externalDir, 'fake.zip');
        await fs.promises.writeFile(fakeZip, 'NOT-A-ZIP');
        const realZip = path.join(externalDir, 'mod.jar');
        await fs.promises.writeFile(realZip, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]));

        const copyJsonRes = await handlers.get('copy-file-to-sandbox')(null, { srcPath: secretJson, destName: 'secret.json' });
        assert.strictEqual(copyJsonRes.success, false);

        const copyFakeRes = await handlers.get('copy-file-to-sandbox')(null, { srcPath: fakeZip, destName: 'fake.zip' });
        assert.strictEqual(copyFakeRes.success, false);

        const copyRealRes = await handlers.get('copy-file-to-sandbox')(null, { srcPath: realZip, destName: 'mod.jar', subDir: 'instances/Test/mods' });
        assert.strictEqual(copyRealRes.success, true);
        assert.ok(fs.existsSync(path.join(sandboxDir, 'instances', 'Test', 'mods', 'mod.jar')));

        // Vérifie la liste blanche Main lorsque isApprovedCopySource est fourni
        const gatedHandlers = new Map();
        setupSystemHandlers({
            ipcMain: { handle: (ch, fn) => gatedHandlers.set(ch, fn) },
            getMainWindow: () => null,
            mainLog: () => {},
            path,
            fs,
            execFile: () => {},
            assertPathUnderSandbox: createSandboxValidator(sandboxDir),
            sanitizeShortcutName: (n) => n,
            isApprovedCopySource: () => false,
            shell: {},
            app: { getPath: () => sandboxDir },
            safeDataDir: sandboxDir,
        });
        const blockedByApproval = await gatedHandlers.get('copy-file-to-sandbox')({ sender: { id: 1 } }, { srcPath: realZip, destName: 'mod2.jar', subDir: 'instances/Test/mods' });
        assert.strictEqual(blockedByApproval.success, false);
        assert.ok(blockedByApproval.error.includes('Source non autorisée'));

        const sizeOk = await handlers.get('get-folder-size')(null, sandboxDir);
        assert.strictEqual(sizeOk.success, true);
        assert.strictEqual(sizeOk.bytes, 6);

        const sizeBad = await handlers.get('get-folder-size')(null, externalDir);
        assert.strictEqual(sizeBad.success, false);

        await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    });

test('ipc-fs fs:readTail returns bounded tail of large file and enforces sandbox', async () => {
        const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens_audit_tail_'));
        const sandboxDir = path.join(tmpRoot, 'sandbox');
        await fs.promises.mkdir(sandboxDir, { recursive: true });
        const bigLog = path.join(sandboxDir, 'latest.log');
        await fs.promises.writeFile(bigLog, 'HEADER-'.repeat(400) + 'TAIL-MARKER', 'utf8');

        const handlers = new Map();
        setupFsHandlers({
            ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
            safeDataDir: sandboxDir,
            mainLog: () => {},
            path,
            fs,
            os,
            app: { getPath: () => sandboxDir, getAppPath: () => sandboxDir },
            assertPathUnderSandbox: createSandboxValidator(sandboxDir),
        });

        const tailRes = await handlers.get('fs:readTail')(null, bigLog, 1024);
        assert.strictEqual(tailRes.ok, true);
        assert.ok(tailRes.data.length <= 1024);
        assert.ok(tailRes.data.endsWith('TAIL-MARKER'));

        const outsideTail = await handlers.get('fs:readTail')(null, path.join(tmpRoot, 'secret.txt'), 1024);
        assert.strictEqual(outsideTail.ok, false);
        assert.strictEqual(outsideTail.error.code, 'EACCES');

        await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    });

test('MCLCore.startMinecraft attaches spawn error listener and does not crash on missing Java binary', async () => {
        const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens_audit_spawn_'));
        const MCLCore = require('../src/gens-core/components/launcher');
        const core = new MCLCore();
        core.options = {
            root: tmpRoot,
            javaPath: path.join(tmpRoot, 'nonexistent-java-binary-12345'),
            overrides: { detached: false },
        };
        const debugLogs = [];
        core.on('debug', (msg) => debugLogs.push(String(msg)));

        const proc = core.startMinecraft(['-version']);
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.ok(proc, 'startMinecraft must return ChildProcess');
        assert.ok(debugLogs.some(l => l.includes('Failed to spawn Java process')), 'Must catch spawn error via debug event');

        await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    });

test('handler & launcher never leak access_token into --xuid, --clientId, or debug logs', async () => {
        const Handler = require('../src/gens-core/components/handler');
        const EventEmitter = require('node:events');
        const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens_audit_tok_'));
        try {
            const client = new EventEmitter();
            const handler = new Handler(client);
            handler.options = {
                root: tmpRoot,
                overrides: {},
                version: { number: '1.20.4', type: 'release' },
                authorization: {
                    access_token: 'SECRET_JWT_TOKEN_VALUE_123456',
                    client_token: 'client-uuid-1234',
                    uuid: 'user-uuid-1',
                    name: 'PlayerOne',
                    user_properties: {},
                    meta: { type: 'msa', demo: false }
                }
            };
            handler.version = {
                id: '1.20.4',
                type: 'release',
                assetIndex: { id: '1.20.4' },
                arguments: {
                    game: ['--username', '${auth_player_name}', '--accessToken', '${auth_access_token}', '--xuid', '${auth_xuid}', '--clientId', '${clientid}']
                }
            };

            const launchOpts = await handler.getLaunchOptions(null);
            const xuidIdx = launchOpts.indexOf('--xuid');
            const clientIdIdx = launchOpts.indexOf('--clientId');
            assert.notStrictEqual(xuidIdx, -1);
            assert.notStrictEqual(launchOpts[xuidIdx + 1], 'SECRET_JWT_TOKEN_VALUE_123456');
            assert.strictEqual(launchOpts[clientIdIdx + 1], 'client-uuid-1234');

            // Vérifie aussi la rédaction dans launcher.launch() debug event
            const MCLCore = require('../src/gens-core/components/launcher');
            const origCheckJava = Handler.prototype.checkJava;
            const origGetNatives = Handler.prototype.getNatives;
            const origGetJVMArgs = Handler.prototype.getJVMArgs;
            const origGetOS = Handler.prototype.getOS;
            const origGetMemory = Handler.prototype.getMemory;
            Handler.prototype.checkJava = async () => ({ run: true });
            Handler.prototype.getNatives = async () => tmpRoot;
            Handler.prototype.getJVMArgs = async () => [];
            Handler.prototype.getOS = () => 'windows';
            Handler.prototype.getMemory = () => ['1024M', '512M'];
            try {
                const verDir = path.join(tmpRoot, 'versions', '1.20.4');
                await fs.promises.mkdir(verDir, { recursive: true });
                await fs.promises.writeFile(path.join(verDir, '1.20.4.json'), JSON.stringify({
                    id: '1.20.4',
                    type: 'release',
                    mainClass: 'net.minecraft.client.main.Main',
                    assetIndex: { id: '1.20.4' },
                    libraries: [],
                    arguments: { jvm: [], game: ['--accessToken', '${auth_access_token}', '--xuid', '${auth_xuid}'] }
                }));
                await fs.promises.writeFile(path.join(verDir, '1.20.4.jar'), 'PK');
                const core = new MCLCore();
                const debugMsgs = [];
                core.on('debug', (m) => debugMsgs.push(String(m)));
                core.startMinecraft = () => /** @type {any} */ ({ pid: 0 });
                await core.launch({
                    root: tmpRoot,
                    javaPath: 'java',
                    offline: true,
                    overrides: { detached: false, directory: verDir, classes: [] },
                    version: { number: '1.20.4', type: 'release' },
                    memory: { max: 1024, min: 512 },
                    authorization: handler.options.authorization,
                });
                const argDebug = debugMsgs.find(m => m.includes('Launching with arguments'));
                assert.ok(argDebug, 'Launching debug message must be emitted');
                assert.strictEqual(argDebug.includes('SECRET_JWT_TOKEN_VALUE_123456'), false, 'access_token must be redacted in debug log');
                assert.ok(argDebug.includes('***REDACTED***'));
            } finally {
                Handler.prototype.checkJava = origCheckJava;
                Handler.prototype.getNatives = origGetNatives;
                Handler.prototype.getJVMArgs = origGetJVMArgs;
                Handler.prototype.getOS = origGetOS;
                Handler.prototype.getMemory = origGetMemory;
            }
        } finally {
            await fs.promises.rm(tmpRoot, { recursive: true, force: true });
        }
    });

test('nbt.js supports 64-bit BigInt longs and block TAG_BYTE_ARRAY round-trip', async () => {
        const payload = {
            type: 'compound',
            name: '',
            value: {
                bigPos: { type: 'long', value: 0x0000000200000005n },
                bigNeg: { type: 'long', value: -42n },
                largeNum: { type: 'long', value: 5000000000 },
                bytes: { type: 'byteArray', value: [1, 2, 127, 255] }
            }
        };
        const buf = nbt.writeUncompressed(payload);
        const decoded = await nbt.parse(buf);
        assert.deepStrictEqual(decoded.parsed.value.bigPos.value, [2, 5]);
        assert.deepStrictEqual(decoded.parsed.value.bigNeg.value, [-1, -42]);
        assert.strictEqual(decoded.parsed.value.largeNum.value[0], 1);
        assert.deepStrictEqual(decoded.parsed.value.bytes.value, [1, 2, 127, 255]);
    });

test('ipc-game blocks -jar, -p, --module-path, flight recording and version traversal; ipc-system blocks executable open-path', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens_audit_extra_sec_'));
    const sandboxDir = path.join(tmpRoot, 'sandbox');
    await fs.promises.mkdir(sandboxDir, { recursive: true });
    try {
        const setupGameHandlers = require('../src/main/ipc-game');
        const setupSystemHandlers = require('../src/main/ipc-system');
        const assertPathUnderSandbox = createSandboxValidator(sandboxDir);

        const gameListeners = new Map();
        const sentEvents = [];
        setupGameHandlers({
            app: { getPath: () => tmpRoot },
            ipcMain: { handle: () => {}, on: (ch, fn) => gameListeners.set(ch, fn) },
            getMainWindow: () => ({
                isDestroyed: () => false,
                webContents: { isDestroyed: () => false, send: (ch, payload) => sentEvents.push({ ch, payload }) }
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

        const launchListener = gameListeners.get('launch-game');
        for (const badFlag of ['-jar', '-p', '--module-path=mods', '-XX:StartFlightRecording=filename=out.jfr']) {
            sentEvents.length = 0;
            await launchListener({}, {
                instanceId: 'inst-flag',
                authorization: { access_token: 'x', uuid: 'u', name: 'p', meta: {} },
                version: { number: '1.20.4', type: 'release' },
                root: path.join(sandboxDir, 'instances', 'inst-flag'),
                customArgs: [badFlag]
            });
            assert.ok(sentEvents.some(e => e.ch === 'mc-close' && e.payload.code === 1), `Flag ${badFlag} should be blocked`);
        }

        sentEvents.length = 0;
        await launchListener({}, {
            instanceId: 'inst-ver',
            authorization: { access_token: 'x', uuid: 'u', name: 'p', meta: {} },
            version: { number: '../../evil', type: 'release' },
            root: path.join(sandboxDir, 'instances', 'inst-ver'),
        });
        assert.ok(sentEvents.some(e => e.ch === 'mc-close' && e.payload.code === 1), 'Version number traversal should be blocked');

        const sysHandles = new Map();
        const openedPaths = [];
        setupSystemHandlers({
            ipcMain: { handle: (ch, fn) => sysHandles.set(ch, fn), on: () => {} },
            getMainWindow: () => null,
            mainLog: () => {},
            path,
            fs,
            execFile: () => {},
            assertPathUnderSandbox,
            sanitizeShortcutName: (n) => n,
            shell: { openPath: async (p) => { openedPaths.push(p); return ''; }, openExternal: async () => {}, showItemInFolder: () => {} },
            app: { isPackaged: false, getVersion: () => '1.9.4' },
            safeDataDir: sandboxDir,
        });

        const openPath = sysHandles.get('system:open-path');
        const fakeExe = path.join(sandboxDir, 'payload.exe');
        const safeTxt = path.join(sandboxDir, 'readme.txt');
        await fs.promises.writeFile(fakeExe, 'MZ');
        await fs.promises.writeFile(safeTxt, 'ok');

        const exeRes = await openPath({}, fakeExe);
        assert.strictEqual(exeRes.success, false);
        assert.match(exeRes.error, /bloquée/i);
        assert.strictEqual(openedPaths.length, 0);

        const txtRes = await openPath({}, safeTxt);
        assert.strictEqual(txtRes.success, true);
        assert.strictEqual(openedPaths.length, 1);
    } finally {
        await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
});

test('Audit Phase 1-4: ipc-fs renderer denylist blocks secrets & java/ writes, plus mixed-slash UNC', async () => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens-ipc-deny-'));
    try {
        const gensDataDir = path.join(tmpRoot, 'GensLauncher');
        const authDir = path.join(gensDataDir, 'Horizon', 'auth');
        const javaDir = path.join(gensDataDir, 'java', 'jdk-21', 'bin');
        await fs.promises.mkdir(authDir, { recursive: true });
        await fs.promises.mkdir(javaDir, { recursive: true });
        const secretKey = path.join(gensDataDir, '.secret_key');
        const tokenFile = path.join(authDir, 'token_google.json');
        const javaBin = path.join(javaDir, 'java.exe');
        await fs.promises.writeFile(secretKey, 'supersecret', 'utf8');
        await fs.promises.writeFile(tokenFile, '{"access_token":"x"}', 'utf8');
        await fs.promises.writeFile(javaBin, 'MZ', 'utf8');

        const { createSandboxValidator, createSandboxValidatorAsync, createRendererPathGuard } = require('../src/main/fs-utils');
        const registerFsIpc = require('../src/main/ipc-fs');
        const allowedRoots = () => [gensDataDir];
        const handlers = new Map();
        const ipcMainMock = { handle: (ch, fn) => handlers.set(ch, fn) };
        registerFsIpc({
            ipcMain: ipcMainMock,
            safeDataDir: gensDataDir,
            app: { getPath: () => tmpRoot, getAppPath: () => tmpRoot },
            fs,
            path,
            os,
            assertPathUnderSandbox: createSandboxValidator(gensDataDir),
        });

        const readSecretRes = await handlers.get('fs:readFile')({}, secretKey, 'utf8');
        assert.strictEqual(readSecretRes.ok, false);
        assert.match(String(readSecretRes.error?.message || ''), /refusé|interdit/i);

        const readTokenRes = await handlers.get('fs:readFile')({}, tokenFile, 'utf8');
        assert.strictEqual(readTokenRes.ok, false);
        assert.match(String(readTokenRes.error?.message || ''), /refusé|interdit/i);

        const writeJavaRes = await handlers.get('fs:writeFile')({}, javaBin, 'evil');
        assert.strictEqual(writeJavaRes.ok, false);
        assert.match(String(writeJavaRes.error?.message || ''), /refusé|interdit/i);

        const rmJavaRes = await handlers.get('fs:rm')({}, javaDir, { recursive: true });
        assert.strictEqual(rmJavaRes.ok, false);
        assert.match(String(rmJavaRes.error?.message || ''), /refusé|interdit/i);

        const uncReadRes = await handlers.get('fs:readFile')({}, '\\/attacker-smb/share/file.txt', 'utf8');
        assert.strictEqual(uncReadRes.ok, false);
        assert.match(String(uncReadRes.error?.message || ''), /UNC|refusé|interdit/i);

        // Reading/statting java.exe remains allowed for detection
        const existsJavaRes = await handlers.get('fs:exists')({}, javaBin);
        assert.strictEqual(existsJavaRes.ok, true);
        assert.strictEqual(existsJavaRes.data, true);
    } finally {
        await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
});

test('Audit Phase 1-4: download-utils blocks multi-tenant CDNs and requires hash on GitHub/GitLab', async () => {
    const { isAllowedDomain, createDownloadFile } = require('../src/main/download-utils');
    assert.strictEqual(isAllowedDomain('bucket.s3.amazonaws.com'), false);
    assert.strictEqual(isAllowedDomain('d1234.cloudfront.net'), false);
    assert.strictEqual(isAllowedDomain('storage.googleapis.com'), false);
    assert.strictEqual(isAllowedDomain('github.com'), true);
    assert.strictEqual(isAllowedDomain('gitlab.com'), true);

    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens-dl-hash-'));
    try {
        const downloadFile = createDownloadFile({
            safeUnlink: async (p) => { try { await fs.promises.unlink(p); } catch (_) {} },
            renameWithRetry: async (a, b) => fs.promises.rename(a, b),
            mainLog: () => {},
            getMainWindow: () => null,
        });
        const tmpFile = path.join(tmpDir, 'a.jar');
        await assert.rejects(
            () => downloadFile('https://github.com/org/repo/releases/download/v1/a.jar', tmpFile, null, null),
            /empreinte|hash/i
        );
    } finally {
        await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
});

test('Audit Phase 1-4: jvm-utils supports legacy --server/--port for MC < 1.20', async () => {
    const jvmUtils = require('../src/gens-core/components/jvm-utils');
    const args = await jvmUtils.buildLaunchOptions({
        version: { id: '1.19.4', arguments: { game: ['--username', '${auth_player_name}'] } },
        modification: null,
        options: {
            authorization: { name: 'Steve', uuid: '0', access_token: 'tok', meta: { type: 'msa' } },
            version: { number: '1.19.4', type: 'release' },
            root: '/tmp/mc',
            server: { host: 'play.example.org', port: 25570 },
            overrides: { gameDirectory: '/tmp/mc', assetRoot: '/tmp/mc/assets' },
        },
        client: { emit: () => {} },
        isLegacy: false,
        assetIndexName: '1.19',
        quickPlayArgs: null,
    });
    const serverIdx = args.indexOf('--server');
    const portIdx = args.indexOf('--port');
    assert.ok(serverIdx >= 0 && args[serverIdx + 1] === 'play.example.org');
    assert.ok(portIdx >= 0 && args[portIdx + 1] === '25570');
});

test('Audit Phase 4: Strict CSP without unsafe-inline and zero inline style attributes across UI', () => {
    const rootDir = path.resolve(__dirname, '..');
    const indexHtml = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
    const mainJs = fs.readFileSync(path.join(rootDir, 'main.js'), 'utf8');

    assert.ok(!indexHtml.includes("'unsafe-inline'"), "index.html CSP ne doit plus contenir 'unsafe-inline'");
    assert.ok(!mainJs.includes("'unsafe-inline'"), "main.js CSP ne doit plus contenir 'unsafe-inline'");
    assert.ok(indexHtml.includes("style-src 'self'"), "index.html doit imposer style-src 'self'");
    assert.ok(indexHtml.includes("frame-src 'none'"), "index.html doit imposer frame-src 'none'");
    assert.ok(indexHtml.includes("child-src 'none'"), "index.html doit imposer child-src 'none'");
    assert.ok(indexHtml.includes("worker-src 'self'"), "index.html doit imposer worker-src 'self'");
    assert.ok(mainJs.includes("frame-ancestors 'none'"), "main.js doit imposer frame-ancestors 'none'");
    assert.ok(indexHtml.includes('src/css/utilities.css'), 'index.html doit charger src/css/utilities.css');
    const utilCssPath = path.join(rootDir, 'src', 'css', 'utilities.css');
    assert.ok(fs.existsSync(utilCssPath), 'src/css/utilities.css doit exister');
    const utilCss = fs.readFileSync(utilCssPath, 'utf8');
    assert.ok(!/^\.\.\s*\{/m.test(utilCss), 'utilities.css ne doit contenir aucun sélecteur invalide .. {');
    assert.ok(utilCss.includes('.u-s067.u-s067 {'), 'utilities.css doit définir les sélecteurs .u-sNNN.u-sNNN');

    const walk = (dir) => {
        const out = [];
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory() && !['node_modules', '.git', 'docs', 'website', 'tests', 'build'].includes(e.name)) {
                out.push(...walk(p));
            } else if (e.isFile() && (p.endsWith('.js') || p.endsWith('index.html'))) {
                out.push(p);
            }
        }
        return out;
    };
    const offenders = [];
    for (const file of walk(rootDir)) {
        const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
        lines.forEach((line, idx) => {
            if (/<[a-zA-Z][^>]*\sstyle\s*=/i.test(line) || /<style\b/i.test(line)) {
                offenders.push(`${path.relative(rootDir, file)}:${idx + 1}`);
            }
        });
    }
    assert.deepStrictEqual(offenders, [], `Inline style= ou <style> détecté(s) : ${offenders.join(', ')}`);
});




