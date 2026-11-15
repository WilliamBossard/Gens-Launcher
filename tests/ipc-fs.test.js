const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSandboxValidator } = require('../src/main/fs-utils');
const setupFsHandlers = require('../src/main/ipc-fs');

test('ipc-fs service handles file operations within sandbox and rejects out-of-scope paths', async (t) => {
    const testSandboxDir = path.join(os.tmpdir(), 'gens_test_sandbox_' + Date.now());
    await fs.promises.mkdir(testSandboxDir, { recursive: true });

    const handlers = new Map();
    const mockIpcMain = {
        handle: (channel, fn) => {
            handlers.set(channel, fn);
        }
    };

    const mockContext = {
        ipcMain: mockIpcMain,
        safeDataDir: testSandboxDir,
        mainLog: () => {},
        path,
        fs,
        os,
        app: {
            getPath: (name) => {
                if (name === 'appData') return testSandboxDir;
                return os.tmpdir();
            },
            getAppPath: () => path.resolve(__dirname, '..')
        },
        assertPathUnderSandbox: createSandboxValidator(testSandboxDir)
    };

    setupFsHandlers(mockContext);

    const testFile = path.join(testSandboxDir, 'test.txt');
    const writeRes = await handlers.get('fs:writeFile')(null, testFile, 'Bonjour Gens Launcher', 'utf8');
    assert.strictEqual(writeRes.ok, true, 'fs:writeFile doit réussir');

    const readRes = await handlers.get('fs:readFile')(null, testFile, 'utf8');
    assert.strictEqual(readRes.ok, true, 'fs:readFile doit réussir');
    assert.strictEqual(readRes.data, 'Bonjour Gens Launcher');

    const statRes = await handlers.get('fs:stat')(null, testFile);
    assert.strictEqual(statRes.ok, true);
    assert.strictEqual(statRes.data.isFile, true);
    assert.strictEqual(statRes.data.isDirectory, false);

    const existsRes = await handlers.get('fs:exists')(null, testFile);
    assert.strictEqual(existsRes.ok, true);
    assert.strictEqual(existsRes.data, true);

    const notExistsRes = await handlers.get('fs:exists')(null, path.join(testSandboxDir, 'inexistant.txt'));
    assert.strictEqual(notExistsRes.ok, true);
    assert.strictEqual(notExistsRes.data, false);

    const readdirRes = await handlers.get('fs:readdir')(null, testSandboxDir);
    assert.strictEqual(readdirRes.ok, true);
    assert.ok(readdirRes.data.includes('test.txt'));

    const renamedFile = path.join(testSandboxDir, 'renamed.txt');
    const renameRes = await handlers.get('fs:rename')(null, testFile, renamedFile);
    assert.strictEqual(renameRes.ok, true);
    assert.strictEqual(fs.existsSync(testFile), false);
    assert.strictEqual(fs.existsSync(renamedFile), true);

    const unlinkRes = await handlers.get('fs:unlink')(null, renamedFile);
    assert.strictEqual(unlinkRes.ok, true);
    assert.strictEqual(fs.existsSync(renamedFile), false);

    const outsideWritePath = path.join(os.tmpdir(), 'evil_write_' + Date.now() + '.txt');
    const outsideWriteRes = await handlers.get('fs:writeFile')(null, outsideWritePath, 'hacked', 'utf8');
    assert.strictEqual(outsideWriteRes.ok, false);
    assert.ok(outsideWriteRes.error.message.includes('sandbox'));
    assert.strictEqual(fs.existsSync(outsideWritePath), false);

    const outsideReadPath = path.join(os.homedir(), '.bashrc_fake_test_123');
    const outsideReadRes = await handlers.get('fs:readFile')(null, outsideReadPath, 'utf8');
    assert.strictEqual(outsideReadRes.ok, false);
    assert.strictEqual(outsideReadRes.error.code, 'EACCES');

    const appendOk = await handlers.get('fs:appendFile')(null, path.join(testSandboxDir, 'append.log'), 'line1\n', 'utf8');
    assert.strictEqual(appendOk.ok, true);

    const badAppendEnc = await handlers.get('fs:appendFile')(null, path.join(testSandboxDir, 'append.log'), 'line2\n', 'utf32');
    assert.strictEqual(badAppendEnc.ok, false);
    assert.ok(badAppendEnc.error.message.includes('Encodage non autorisé'));

    await fs.promises.rm(testSandboxDir, { recursive: true, force: true });
});

test('ipc-fs resolves newly created allowedReadRoots dynamically without caching stale parent realpath', async () => {
    const tmpBase = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens_dyn_roots_'));
    const lateAppData = path.join(tmpBase, 'late_appdata');
    const sandboxDir = path.join(tmpBase, 'sandbox');
    await fs.promises.mkdir(sandboxDir, { recursive: true });

    const handlers = new Map();
    setupFsHandlers({
        ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
        safeDataDir: sandboxDir,
        mainLog: () => {},
        path,
        fs,
        os,
        app: {
            getPath: (name) => (name === 'appData' ? lateAppData : tmpBase),
            getAppPath: () => path.resolve(__dirname, '..')
        },
        assertPathUnderSandbox: createSandboxValidator(sandboxDir)
    });

    try {
        const lateRoot = path.join(lateAppData, '.minecraft', 'saves');
        await fs.promises.mkdir(lateRoot, { recursive: true });
        const lateJson = path.join(lateRoot, 'late.json');
        await fs.promises.writeFile(lateJson, '{"ok":true}', 'utf8');

        const readLate = await handlers.get('fs:readFile')(null, lateJson, 'utf8');
        assert.strictEqual(readLate.ok, true, 'La lecture dans une racine créée après init doit être autorisée');
        assert.strictEqual(readLate.data, '{"ok":true}');

        const outsideFile = path.join(tmpBase, 'secret.json');
        await fs.promises.writeFile(outsideFile, '{"secret":1}', 'utf8');
        const readOutside = await handlers.get('fs:readFile')(null, outsideFile, 'utf8');
        assert.strictEqual(readOutside.ok, false);
        assert.strictEqual(readOutside.error.code, 'EACCES');
    } finally {
        await fs.promises.rm(tmpBase, { recursive: true, force: true });
    }
});

