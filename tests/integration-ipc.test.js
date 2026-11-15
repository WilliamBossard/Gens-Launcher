const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');

const { pipeStreams } = require('../src/main/zip-utils');
const { existsSafe } = require('../src/main/fs-utils');
const { createDownloadFile } = require('../src/main/download-utils');
const setupHorizonHandlers = require('../src/main/ipc-horizon');

async function safeUnlink(p) {
    try { await fs.promises.unlink(p); } catch (_) {}
}

test('Integration & Quality Checks', async (t) => {
    await t.test('download-utils streams chunked ReadableStream, verifies SHA-256/SHA-1, aborts idle stream, cleans .tmp on mismatch, and blocks disallowed domains/redirects', async () => {
        const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens_dl_int_'));
        const payload = Buffer.from('Minecraft-Mod-Jar-Payload-1234567890'.repeat(128));
        const sha256 = crypto.createHash('sha256').update(payload).digest('hex');
        const sha1 = crypto.createHash('sha1').update(payload).digest('hex');

        const makeChunkedResponse = (buf) => new Response(new ReadableStream({
            start(controller) {
                const mid = Math.floor(buf.length / 2);
                controller.enqueue(new Uint8Array(buf.subarray(0, mid)));
                setTimeout(() => {
                    controller.enqueue(new Uint8Array(buf.subarray(mid)));
                    controller.close();
                }, 10);
            }
        }), {
            status: 200,
            headers: {
                'Content-Type': 'application/java-archive',
                'Content-Length': String(buf.length)
            }
        });

        /** @type {typeof fetch} */
        const mockFetch = async (url, init) => {
            const target = String(url);
            if (target === 'https://cdn.modrinth.com/redirect-good') {
                return new Response(null, { status: 302, headers: { Location: 'https://cdn.modrinth.com/mod.jar' } });
            }
            if (target === 'https://cdn.modrinth.com/redirect-evil') {
                return new Response(null, { status: 302, headers: { Location: 'https://evil.example.org/payload.jar' } });
            }
            if (target === 'https://cdn.modrinth.com/mod.jar') {
                return makeChunkedResponse(payload);
            }
            if (target === 'https://cdn.modrinth.com/stalled.jar') {
                return new Response(new ReadableStream({
                    start(controller) {
                        controller.enqueue(new Uint8Array(Buffer.from('partial-')));
                        init?.signal?.addEventListener('abort', () => {
                            try { controller.error(new Error('Aborted')); } catch (_) {}
                        }, { once: true });
                    }
                }), { status: 200, headers: { 'Content-Length': '999999' } });
            }
            return new Response('Not found', { status: 404 });
        };

        try {
            const download = createDownloadFile({
                fs, path, crypto, pipeStreams, existsSafe, safeUnlink,
                fetchFn: mockFetch,
                inactivityTimeoutMs: 60
            });

            await assert.rejects(
                () => download('http://cdn.modrinth.com/mod.jar', path.join(tmpRoot, 'insecure.jar')),
                /HTTPS/
            );
            await assert.rejects(
                () => download('https://evil.example.org/mod.jar', path.join(tmpRoot, 'blocked.jar')),
                /Domaine non autorisé/
            );

            // 1. Redirection autorisée + progression + vérification SHA-256
            const dest256 = path.join(tmpRoot, 'ok256.jar');
            const progressEvents = [];
            await download('https://cdn.modrinth.com/redirect-good', dest256, {
                expectedHash: sha256,
                hashAlgo: 'sha256',
                onProgress: (p) => progressEvents.push(p)
            });
            assert.deepStrictEqual(await fs.promises.readFile(dest256), payload);
            assert.ok(progressEvents.length > 0 && progressEvents[progressEvents.length - 1].percent === 100);

            // 2. Vérification SHA-1 générique
            const destSha1 = path.join(tmpRoot, 'ok1.jar');
            await download('https://cdn.modrinth.com/mod.jar', destSha1, {
                expectedHash: sha1,
                hashAlgo: 'sha1'
            });
            assert.deepStrictEqual(await fs.promises.readFile(destSha1), payload);

            // 3. Mauvais hash -> rejet + aucun .tmp résiduel
            const badDest = path.join(tmpRoot, 'bad.jar');
            await assert.rejects(
                () => download('https://cdn.modrinth.com/mod.jar', badDest, { expectedHash: '0'.repeat(64), hashAlgo: 'sha256' }),
                /Échec de la vérification SHA256/
            );
            assert.strictEqual(await existsSafe(badDest), false);
            const leftovers = (await fs.promises.readdir(tmpRoot)).filter(f => f.startsWith('bad.jar.tmp.'));
            assert.strictEqual(leftovers.length, 0, 'temporary files must be cleaned on hash failure');

            // 4. Redirection vers domaine non autorisé rejetée
            await assert.rejects(
                () => download('https://cdn.modrinth.com/redirect-evil', path.join(tmpRoot, 'evil.jar')),
                /Domaine non autorisé/
            );

            // 5. Timeout d'inactivité déclenché sur flux bloqué + nettoyage .tmp
            const stalledDest = path.join(tmpRoot, 'stalled.jar');
            await assert.rejects(
                () => download('https://cdn.modrinth.com/stalled.jar', stalledDest)
            );
            assert.strictEqual(await existsSafe(stalledDest), false);
            const stalledLeftovers = (await fs.promises.readdir(tmpRoot)).filter(f => f.startsWith('stalled.jar.tmp.'));
            assert.strictEqual(stalledLeftovers.length, 0);
        } finally {
            await fs.promises.rm(tmpRoot, { recursive: true, force: true });
        }
    });

    await t.test('ipc-horizon seals github_release_cache.json using async safeStorage only and rejects tampered cache', async () => {
        const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens_horizon_hmac_'));
        const origLoad = Module._load;
        let encryptAsyncCalls = 0;
        let decryptAsyncCalls = 0;

        Module._load = function (request, parent, isMain) {
            if (request === 'electron') {
                return {
                    safeStorage: {
                        isAsyncEncryptionAvailable: async () => true,
                        encryptStringAsync: async (str) => {
                            encryptAsyncCalls++;
                            return Buffer.from('SEALED:' + str, 'utf8');
                        },
                        decryptStringAsync: async (buf) => {
                            decryptAsyncCalls++;
                            const text = Buffer.from(buf).toString('utf8');
                            return { result: text.startsWith('SEALED:') ? text.slice(7) : '' };
                        }
                    }
                };
            }
            return origLoad.apply(this, arguments);
        };

        try {
            const createHandlers = () => {
                const handlers = new Map();
                const horizonDir = path.join(tmpRoot, 'Horizon');
                setupHorizonHandlers({
                    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
                    safeDataDir: tmpRoot,
                    mainLog: () => {},
                    path,
                    fs,
                    crypto,
                    spawn: () => { throw new Error('unexpected spawn'); },
                    app: { isPackaged: false },
                    horizonBinDir: horizonDir,
                    horizonExePath: path.join(horizonDir, process.platform === 'win32' ? 'Horizon.exe' : 'Horizon'),
                    horizonVersionPath: path.join(horizonDir, 'horizon_version.json'),
                    horizonDir,
                    horizonLegacyBinDir: path.join(tmpRoot, 'bin'),
                    horizonAuthDir: path.join(horizonDir, 'auth'),
                    horizonMetaDir: path.join(horizonDir, 'metadata'),
                    horizonManifestsDir: path.join(horizonDir, 'manifests'),
                    horizonCacheDir: path.join(horizonDir, 'cache'),
                    isWin: process.platform === 'win32',
                    safeSend: () => {}
                });
                return handlers;
            };

            const horizonDir = path.join(tmpRoot, 'Horizon');
            await fs.promises.mkdir(horizonDir, { recursive: true });
            const exePath = path.join(horizonDir, process.platform === 'win32' ? 'Horizon.exe' : 'Horizon');
            await fs.promises.writeFile(exePath, 'dummy-horizon-binary');
            await fs.promises.writeFile(path.join(horizonDir, 'horizon_version.json'), JSON.stringify({ version: 'v1.0.0' }));

            // Remplir le cache via fetch mocké pour l'API GitHub uniquement
            const origFetch = global.fetch;
            global.fetch = async (url) => {
                if (String(url).includes('api.github.com')) {
                    return new Response(JSON.stringify({ tag_name: 'v1.2.3', assets: [] }), {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' }
                    });
                }
                throw new Error('Unexpected fetch URL: ' + url);
            };

            try {
                const handlers1 = createHandlers();
                const statusRes = await handlers1.get('check-horizon-status')();
                assert.strictEqual(statusRes.needsUpdate, true);
                assert.strictEqual(statusRes.latestVersion, 'v1.2.3');
                assert.ok(encryptAsyncCalls >= 1, 'must generate and seal horizon_seal.key via encryptStringAsync');

                const cachePath = path.join(tmpRoot, 'github_release_cache.json');
                const cachedObj = JSON.parse(await fs.promises.readFile(cachePath, 'utf8'));
                assert.ok(typeof cachedObj._sig === 'string' && cachedObj._sig.length === 64);

                // Au redémarrage, déchiffre horizon_seal.key et lit le cache valide hors-ligne
                const handlers2 = createHandlers();
                global.fetch = async () => { throw new Error('network offline'); };
                const statusResCached = await handlers2.get('check-horizon-status')();
                assert.ok(decryptAsyncCalls >= 1, 'must unseal horizon_seal.key via decryptStringAsync');
                assert.strictEqual(statusResCached.latestVersion, 'v1.2.3');

                // Altération du cache -> signature HMAC invalide -> version falsifiée rejetée
                cachedObj.latest = 'v9.9.9-pwned';
                await fs.promises.writeFile(cachePath, JSON.stringify(cachedObj), 'utf8');
                const handlers3 = createHandlers();
                const statusResTampered = await handlers3.get('check-horizon-status')();
                assert.notStrictEqual(statusResTampered.latestVersion, 'v9.9.9-pwned');
            } finally {
                global.fetch = origFetch;
            }
        } finally {
            Module._load = origLoad;
            await fs.promises.rm(tmpRoot, { recursive: true, force: true });
        }
    });

    await t.test('Code quality: no unguarded deprecated safeStorage sync APIs and packaging whitelist covers src/', async () => {
        const rootDir = path.resolve(__dirname, '..');
        const pkg = JSON.parse(await fs.promises.readFile(path.join(rootDir, 'package.json'), 'utf8'));
        assert.ok(Array.isArray(pkg.build?.files) && pkg.build.files.includes('src/**/*'));
        assert.ok(pkg.build.files.includes('main.js') && pkg.build.files.includes('preload.js'));

        const mainJs = await fs.promises.readFile(path.join(rootDir, 'main.js'), 'utf8');
        assert.strictEqual(/safeStorage\.(isEncryptionAvailable|encryptString|decryptString)\(/.test(mainJs), false);

        const cryptoUtils = await fs.promises.readFile(path.join(rootDir, 'src/main/crypto-utils.js'), 'utf8');
        assert.strictEqual(/safeStorage\.(isEncryptionAvailable|encryptString|decryptString)\(/.test(cryptoUtils), false);
    });
});
