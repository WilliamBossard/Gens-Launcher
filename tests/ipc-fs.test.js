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

    await fs.promises.rm(testSandboxDir, { recursive: true, force: true });
});

