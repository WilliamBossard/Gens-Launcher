const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const yauzl = require('yauzl-promise');
const { createSandboxValidator, parseMotdComponent } = require('../src/main/fs-utils');
const Handler = require('../src/gens-core/components/handler');

test('assertPathUnderSandbox - confinement lexical et protection symlink/junction', async () => {
    const baseTmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens-sandbox-test-'));
    const sandboxDir = path.join(baseTmp, 'GensLauncher');
    const siblingDir = path.join(baseTmp, 'GensLauncher_outside');
    await fs.promises.mkdir(sandboxDir, { recursive: true });
    await fs.promises.mkdir(siblingDir, { recursive: true });

    try {
        const assertPathUnderSandbox = createSandboxValidator(sandboxDir);

        // 1. Chemins valides dans le sandbox
        const validFile = path.join(sandboxDir, 'instances', 'MonInstance', 'mods', 'sodium.jar');
        assert.strictEqual(assertPathUnderSandbox(validFile), path.resolve(validFile));
        assert.strictEqual(assertPathUnderSandbox(sandboxDir), path.resolve(sandboxDir));

        // 2. Traversée de chemin (..) et dossier frère partageant le même préfixe
        assert.throws(() => assertPathUnderSandbox(path.join(sandboxDir, '..', 'outside.txt')), /hors du sandbox/);
        assert.throws(() => assertPathUnderSandbox(path.join(siblingDir, 'secret.txt')), /hors du sandbox/);
        assert.throws(() => assertPathUnderSandbox(''), /hors du sandbox/);
        assert.throws(() => assertPathUnderSandbox(null), /hors du sandbox/);

        // 3. Protection contre un symlink / junction pointant hors du sandbox
        const linkPath = path.join(sandboxDir, 'linked_outside');
        const linkType = process.platform === 'win32' ? 'junction' : 'dir';
        const origRealpathSync = fs.realpathSync;
        try {
            await fs.promises.symlink(siblingDir, linkPath, linkType);
        } catch (err) {
            if (err.code !== 'EPERM') throw err;
            await fs.promises.mkdir(linkPath, { recursive: true });
            fs.realpathSync = (p) => (path.resolve(p) === path.resolve(linkPath) ? siblingDir : origRealpathSync(p));
        }

        try {
            assert.throws(
                () => assertPathUnderSandbox(path.join(linkPath, 'escaped.txt')),
                /hors du sandbox/,
                'Un lien symbolique ou junction pointant hors du sandbox doit être bloqué'
            );
        } finally {
            fs.realpathSync = origRealpathSync;
        }
    } finally {
        await fs.promises.rm(baseTmp, { recursive: true, force: true });
    }
});

test('parseMotdComponent - échappement XSS et validation des couleurs', () => {
    // 1. Balises HTML malveillantes dans un MOTD legacy ou JSON
    const maliciousLegacy = '§aBienvenue <img src=x onerror=alert(1)> & "amis" <3';
    const html1 = parseMotdComponent(maliciousLegacy);
    assert.ok(!html1.includes('<img'), 'Les balises <img> ne doivent jamais passer');
    assert.ok(html1.includes('&lt;img src=x onerror=alert(1)&gt;'), 'Le HTML doit être échappé');
    assert.ok(html1.includes('&lt;3'), 'Les chevrons littéraux (<3) doivent être préservés par échappement');
    assert.ok(html1.includes('<span style="color: #5f5;">'), 'Les codes couleur § doivent toujours fonctionner');

    // 2. Injection CSS via comp.color
    const maliciousComp = {
        text: 'Serveur ',
        color: '#ff0000; background:url(javascript:alert(1))',
        bold: true,
        extra: [
            { text: '<script>alert(1)</script>', color: 'gold' },
            { text: ' OK', color: '#12abef' }
        ]
    };
    const html2 = parseMotdComponent(maliciousComp);
    assert.ok(!html2.includes('background'), 'Une couleur hex invalide contenant du CSS doit être rejetée');
    assert.ok(!html2.includes('<script>'), 'Les balises <script> dans extra doivent être échappées');
    assert.ok(html2.includes('color: #FFAA00;'), 'Les couleurs nommées Minecraft valides doivent être appliquées');
    assert.ok(html2.includes('color: #12abef;'), 'Les couleurs hex valides doivent être appliquées');
});

test('compress-worker, extract-worker (.zip) et lecture entry.filename (yauzl-promise)', async () => {
    const baseTmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens-zip-test-'));
    const srcDir = path.join(baseTmp, 'src_instance');
    const extractDir = path.join(baseTmp, 'extracted');
    const zipPath = path.join(baseTmp, 'pack.zip');

    try {
        await fs.promises.mkdir(path.join(srcDir, 'mods'), { recursive: true });
        const modMeta = JSON.stringify({ id: 'sodium', name: 'Sodium Édition Française', depends: { fabricloader: '>=0.15.0', iris: '*' } });
        await fs.promises.writeFile(path.join(srcDir, 'fabric.mod.json'), modMeta, 'utf8');
        await fs.promises.writeFile(path.join(srcDir, 'instance.lock'), '12345', 'utf8');
        await fs.promises.writeFile(path.join(srcDir, 'mods', 'dummy.txt'), 'contenu mod', 'utf8');

        // 1. Compression via compress-worker.js avec exclusion de instance.lock
        const compressRes = await new Promise((resolve, reject) => {
            const worker = new Worker(path.join(__dirname, '..', 'src', 'workers', 'compress-worker.js'), {
                workerData: { src: srcDir, dest: zipPath, exclude: ['instance.lock'] }
            });
            worker.on('message', (msg) => { if (msg.type === 'done') resolve(msg); });
            worker.on('error', reject);
        });
        assert.strictEqual(compressRes.success, true, 'compress-worker doit réussir');

        // 2. Lecture de fabric.mod.json via yauzl-promise (vérifie entry.filename + UTF-8)
        const zipfile = await yauzl.open(zipPath);
        let foundText = null;
        let foundLock = false;
        try {
            for await (const entry of zipfile) {
                if (entry.filename === 'instance.lock') foundLock = true;
                if (entry.filename === 'fabric.mod.json') {
                    const readStream = await entry.openReadStream();
                    const chunks = [];
                    for await (const chunk of readStream) chunks.push(chunk);
                    foundText = Buffer.concat(chunks).toString('utf8');
                }
            }
        } finally {
            await zipfile.close();
        }
        assert.strictEqual(foundLock, false, 'instance.lock doit être exclu de l’archive');
        assert.strictEqual(foundText, modMeta, 'entry.filename doit permettre de lire fabric.mod.json en UTF-8');

        // 3. Extraction ZIP via extract-worker.js (mode isWin = true)
        const extractRes = await new Promise((resolve, reject) => {
            const worker = new Worker(path.join(__dirname, '..', 'src', 'workers', 'extract-worker.js'), {
                workerData: { archivePath: zipPath, destDir: extractDir, isWin: true }
            });
            worker.on('message', (msg) => { if (msg.type === 'done') resolve(msg); });
            worker.on('error', reject);
        });
        assert.strictEqual(extractRes.success, true, 'extract-worker doit extraire le .zip sans erreur entry.filename');
        const extractedDummy = await fs.promises.readFile(path.join(extractDir, 'mods', 'dummy.txt'), 'utf8');
        assert.strictEqual(extractedDummy, 'contenu mod');
    } finally {
        await fs.promises.rm(baseTmp, { recursive: true, force: true });
    }
});

test('Cloud Sync (Lot 5) & Java dynamique (Lot 6) - priorité des modifications locales et lecture majorVersion', async () => {
    const baseTmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens-cloud-test-'));
    try {
        global.window = {
            api: {
                appData: baseTmp,
                platform: process.platform,
                fs: {
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
                },
                path,
                os,
                invoke: async () => ({}),
                send: () => {},
                on: () => () => {},
            },
            safeDir: (name) => String(name || '').replace(/[^a-zA-Z0-9_\-]/g, '_'),
            existsSafe: async (p) => fs.promises.access(p).then(() => true).catch(() => false),
            safeWriteJSONAsync: async (file, data) => {
                await fs.promises.mkdir(path.dirname(file), { recursive: true });
                await fs.promises.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
            },
            t: (_k, fallback) => fallback || _k,
            showToast: () => {},
        };

        const { store } = await import('../src/store.js');
        const { writeInstanceMetaForCloud, mergeInstanceConfigFromDisk, detectRequiredJavaVersion } = await import('../src/launch/launchCore.js');

        store.instancesRoot = path.join(baseTmp, 'GensLauncher', 'instances');
        store.instanceFile = path.join(baseTmp, 'GensLauncher', 'instances.json');

        const inst = {
            name: 'Survie Fabric',
            version: '1.21.1',
            loader: 'fabric',
            loaderVersion: '0.16.10',
            ram: '4096',
            _localConfigUpdatedAt: 2000000,
        };
        store.allInstances = [inst];

        const instFolder = path.join(store.instancesRoot, 'Survie_Fabric');
        const metaDir = path.join(instFolder, 'gens');
        await fs.promises.mkdir(metaDir, { recursive: true });

        // 1. Simuler un ancien fichier cloud (version 0.16.9, timestamp 1000000 < 2000000) restauré par Horizon --sync
        await fs.promises.writeFile(
            path.join(metaDir, 'launcher_config.json'),
            JSON.stringify({ version: '1.21.1', loader: 'fabric', loaderVersion: '0.16.9', _cloudExportedAt: 1000000 }, null, 2),
            'utf8'
        );

        const changedWhenOlder = await mergeInstanceConfigFromDisk('Survie_Fabric');
        assert.strictEqual(changedWhenOlder, false, 'Une ancienne config cloud ne doit jamais écraser une modification locale plus récente');
        assert.strictEqual(inst.loaderVersion, '0.16.10', 'La version du loader Fabric modifiée localement doit rester 0.16.10');

        // Vérifier que launcher_config.json sur disque a été resynchronisé avec la version locale (0.16.10)
        const repairedMeta = JSON.parse(await fs.promises.readFile(path.join(metaDir, 'launcher_config.json'), 'utf8'));
        assert.strictEqual(repairedMeta.loaderVersion, '0.16.10', 'launcher_config.json doit être mis à jour avec la nouvelle version locale');

        // 2. Simuler une config cloud plus récente venant d'un autre PC (version 0.16.12, timestamp 3000000 > 2000000)
        await fs.promises.writeFile(
            path.join(metaDir, 'launcher_config.json'),
            JSON.stringify({ version: '1.21.1', loader: 'fabric', loaderVersion: '0.16.12', _cloudExportedAt: 3000000 }, null, 2),
            'utf8'
        );

        const changedWhenNewer = await mergeInstanceConfigFromDisk('Survie_Fabric');
        assert.strictEqual(changedWhenNewer, true, 'Une config cloud plus récente (autre PC) doit être appliquée');
        assert.strictEqual(inst.loaderVersion, '0.16.12', 'La version du loader doit passer à 0.16.12');
        assert.strictEqual(inst._localConfigUpdatedAt, 3000000);

        // 3. Test pérennité 5+ ans : lecture dynamique de javaVersion.majorVersion (ex: MC 29.1 -> Java 29)
        const futureVerDir = path.join(instFolder, 'versions', '29.1');
        await fs.promises.mkdir(futureVerDir, { recursive: true });
        await fs.promises.writeFile(
            path.join(futureVerDir, '29.1.json'),
            JSON.stringify({ id: '29.1', javaVersion: { component: 'java-runtime-zeta', majorVersion: 29 } }),
            'utf8'
        );
        const detectedJava = await detectRequiredJavaVersion({ version: '29.1' }, instFolder);
        assert.strictEqual(detectedJava, 29, 'detectRequiredJavaVersion doit lire majorVersion=29 depuis le JSON Mojang');
    } finally {
        await fs.promises.rm(baseTmp, { recursive: true, force: true });
    }
});

test('Gens-Core Handler (Lot 6 & 7) - interpolation complète getJVMArgs et verifyFileFast par taille', async () => {
    const baseTmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gens-handler-test-'));
    try {
        const fakeClient = {
            options: {
                root: baseTmp,
                version: { number: '1.21.1', custom: 'neoforge-21.1.77', type: 'release' },
                overrides: {}
            },
            emit: () => {}
        };
        const handler = new Handler(fakeClient);
        handler.version = {
            id: '1.21.1',
            arguments: {
                jvm: [
                    '-Djava.library.path=${natives_directory}',
                    '-DlibraryDirectory=${library_directory}'
                ]
            }
        };
        const modifyJson = {
            arguments: {
                jvm: [
                    '-DlibraryDirectory=${library_directory}',
                    '-p',
                    '${library_directory}/cpw/mods/bootstraplauncher/bootstraplauncher.jar${classpath_separator}${library_directory}/net/neoforged/JarJar.jar',
                    '--add-opens', 'java.base/java.util.jar=cpw.mods.securejarhandler',
                    '--add-opens', 'java.base/java.lang.invoke=cpw.mods.securejarhandler',
                    '-Dneoforge.version=${version_name}'
                ]
            }
        };

        const nativePath = path.join(baseTmp, 'natives', '1.21.1');
        const jvmArgs = await handler.getJVMArgs(modifyJson, nativePath);
        const expectedLibDir = path.resolve(path.join(baseTmp, 'libraries'));
        const expectedSep = handler.getOS() === 'windows' ? ';' : ':';

        assert.ok(jvmArgs.includes(`-DlibraryDirectory=${expectedLibDir}`), '${library_directory} doit être interpolé');
        assert.strictEqual(
            jvmArgs.filter(a => a === `-DlibraryDirectory=${expectedLibDir}`).length,
            1,
            'Les flags -D identiques doivent être dédupliqués'
        );
        assert.ok(
            jvmArgs.includes(`${expectedLibDir}/cpw/mods/bootstraplauncher/bootstraplauncher.jar${expectedSep}${expectedLibDir}/net/neoforged/JarJar.jar`),
            '${classpath_separator} et ${library_directory} doivent être interpolés dans le module-path'
        );
        assert.ok(jvmArgs.includes('-Dneoforge.version=neoforge-21.1.77'), '${version_name} doit être interpolé');
        assert.strictEqual(
            jvmArgs.filter(a => a === '--add-opens').length,
            2,
            'Les flags multi-occurrences --add-opens doivent tous être préservés'
        );

        // Test verifyFileFast : comparaison par taille O(1)
        const sampleFile = path.join(baseTmp, 'asset.bin');
        await fs.promises.writeFile(sampleFile, Buffer.alloc(1234, 0x42));
        assert.strictEqual(await handler.verifyFileFast(sampleFile, 1234, 'deadbeef'), true, 'Taille identique = validation rapide réussie');
        assert.strictEqual(await handler.verifyFileFast(sampleFile, 9999, 'deadbeef'), false, 'Taille différente = doit retourner false');
        assert.strictEqual(await handler.verifyFileFast(path.join(baseTmp, 'missing.bin'), 1234, 'deadbeef'), false, 'Fichier manquant = false');
    } finally {
        await fs.promises.rm(baseTmp, { recursive: true, force: true });
    }
});
