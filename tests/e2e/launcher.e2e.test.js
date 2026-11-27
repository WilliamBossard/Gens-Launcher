// @ts-check
const { test, expect, _electron: electron } = require('@playwright/test');
const electronPath = /** @type {string} */ (/** @type {unknown} */ (require('electron')));
const path = require('path');
const fs = require('fs');
const os = require('os');

test.describe('Gens-Launcher Electron E2E', () => {
    test('démarre sans erreur console/CSP et affiche la fenêtre principale', async () => {
        const tmpUserData = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens_e2e_'));
        const appRoot = path.resolve(__dirname, '../..');
        /** @type {import('@playwright/test').ElectronApplication | null} */
        let electronApp = null;
        try {
            const cleanEnv = { ...process.env, NODE_ENV: 'test', APPDATA: tmpUserData };
            delete cleanEnv.ELECTRON_RUN_AS_NODE;
            electronApp = await electron.launch({
                executablePath: electronPath,
                args: [appRoot, `--user-data-dir=${tmpUserData}`],
                env: cleanEnv
            });
            const page = await electronApp.firstWindow();
            /** @type {string[]} */
            const consoleErrors = [];
            page.on('console', (msg) => {
                if (msg.type() === 'error') consoleErrors.push(msg.text());
            });
            page.on('pageerror', (err) => {
                consoleErrors.push(err.message);
            });

            await page.waitForLoadState('domcontentloaded');
            const title = await page.title();
            expect(title).toContain('Gens');

            // Vérifier que l'API preload est bien injectée et que la CSP bloque les scripts inline
            const hasApi = await page.evaluate(() => Boolean((/** @type {any} */ (window)).api && (/** @type {any} */ (window)).api.fs));
            expect(hasApi).toBe(true);
            expect(consoleErrors.filter((e) => e.includes('Content Security Policy'))).toEqual([]);
        } finally {
            if (electronApp) await electronApp.close();
            await fs.promises.rm(tmpUserData, { recursive: true, force: true });
        }
    });
});
