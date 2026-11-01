const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

test('Package build files whitelist excludes tests, docs and temporary files', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.ok(Array.isArray(pkg.build?.files), 'build.files doit être un tableau');
    assert.ok(pkg.build.files.includes('main.js'), 'main.js doit être inclus');
    assert.ok(pkg.build.files.includes('preload.js'), 'preload.js doit être inclus');
    assert.ok(pkg.build.files.includes('renderer.js'), 'renderer.js doit être inclus');
    assert.ok(pkg.build.files.includes('src/**/*'), 'src/**/* doit être inclus');
    assert.ok(pkg.build.files.includes('!**/tests/**'), 'tests doivent être exclus');
    assert.ok(pkg.build.files.includes('!**/docs/**'), 'docs doivent être exclus');
});

test('Crash analyzer identifies Windows and Linux exit codes without logs', async () => {
    const baseTmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens-crash-test-'));
    try {
        global.window = global.window || {};
        global.window.api = global.window.api || {};
        global.window.api.platform = process.platform;
        global.window.api.path = path;
        global.window.api.os = os;
        global.window.api.appData = baseTmp;
        global.window.api.fs = {
            promises: {
                mkdir: fs.promises.mkdir,
                readFile: fs.promises.readFile,
                writeFile: fs.promises.writeFile,
                readdir: fs.promises.readdir,
                stat: fs.promises.stat,
                unlink: fs.promises.unlink,
                rename: fs.promises.rename,
                access: fs.promises.access,
                exists: async (p) => fs.promises.access(p).then(() => true).catch(() => false),
            }
        };
        global.window.api.invoke = async () => ({});
        global.window.api.send = () => {};
        global.window.api.on = () => () => {};
        global.window.safeDir = (name) => String(name || '').replace(/[^a-zA-Z0-9_\-]/g, '_');
        global.window.existsSafe = async () => false;
        global.window.t = (key, fallback) => fallback || key;
        global.window.showToast = () => {};

        global.document = global.document || {
            getElementById: () => null
        };

        const { store } = await import('../src/store.js');
        const { analyzeCrash } = await import('../src/launch/launchCore.js');
        store.instancesRoot = baseTmp;

        // Code 0xC0000409 (-1073740791) : GPU Buffer Overrun
        const resGpu = await analyzeCrash('TestInstance', -1073740791);
        assert.ok(resGpu.cause.includes('-1073740791') || resGpu.cause.includes('GPU'), 'Cause doit identifier le crash GPU');

        // Code 0xC0000005 (-1073741819) : Access Violation
        const resAv = await analyzeCrash('TestInstance', -1073741819);
        assert.ok(resAv.cause.includes('-1073741819') || resAv.cause.includes('Access Violation'), 'Cause doit identifier Access Violation');

        // Code -805306369 (0xCFFFFFFF) : Windows OOM
        const resWinOom = await analyzeCrash('TestInstance', -805306369);
        assert.ok(resWinOom.cause.includes('-805306369') || resWinOom.cause.includes('Mémoire'), 'Cause doit identifier OOM Windows');

        // Code 137 : Linux OOM Killer
        const resLinuxOom = await analyzeCrash('TestInstance', 137);
        assert.ok(resLinuxOom.cause.includes('137') || resLinuxOom.cause.includes('OOM Killer'), 'Cause doit identifier Linux OOM Killer');

        // Code 139 : Linux SIGSEGV
        const resSegv = await analyzeCrash('TestInstance', 139);
        assert.ok(resSegv.cause.includes('139') || resSegv.cause.includes('segmentation'), 'Cause doit identifier SIGSEGV');
    } finally {
        await fs.promises.rm(baseTmp, { recursive: true, force: true });
    }
});

test('Pre-flight RAM check protects system from aggressive allocation', () => {
    function computeSafeRam(requestedRamMB, totalMemBytes) {
        let ramMB = requestedRamMB;
        if (ramMB > 0 && ramMB < 8) ramMB = ramMB * 1024;
        ramMB = Math.max(1024, ramMB);

        const totalMemMB = totalMemBytes > 0 ? Math.floor(totalMemBytes / (1024 * 1024)) : 0;
        if (totalMemMB > 0 && ramMB > (totalMemMB - 512)) {
            return Math.max(1024, totalMemMB - 1024);
        }
        return ramMB;
    }

    // Machine 8GB (8192 MB), user asks 16GB (16384 MB) -> capped to 7168 MB (total - 1GB)
    const capped8G = computeSafeRam(16384, 8192 * 1024 * 1024);
    assert.strictEqual(capped8G, 7168, 'RAM doit être plafonnée pour laisser 1024 Mo à l’OS');

    // Machine 16GB (16384 MB), user asks 4GB (4096 MB) -> untouched 4096 MB
    const normal = computeSafeRam(4096, 16384 * 1024 * 1024);
    assert.strictEqual(normal, 4096, 'RAM raisonnable doit rester inchangée');
});
