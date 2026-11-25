// @ts-check
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const { Zip, existsAsync } = require('./zip-archive');
const {
  pMap,
  baseRequest,
  fetchText,
  downloadFileAsync,
  writeFileAtomic,
  checkSum,
  verifyFileFast
} = require('./network-utils');
const jvmUtils = require('./jvm-utils');
const { resolveForgedWrapped } = require('./forge-wrapper');

class Handler {
  /**
   * @param {any} client
   */
  constructor(client) {
    this.client = client
    this.options = client.options
    /** @type {any} */
    this.version = null
  }

  /**
   * @template T, R
   * @param {T[]} array
   * @param {number} limit
   * @param {(item: T, index: number, array: T[]) => Promise<R> | R} asyncCallback
   */
  static pMap(array, limit, asyncCallback) {
    return pMap(array, limit, asyncCallback);
  }

  /**
   * @template T, R
   * @param {T[]} array
   * @param {number} limit
   * @param {(item: T, index: number, array: T[]) => Promise<R> | R} asyncCallback
   */
  pMap(array, limit, asyncCallback) {
    return pMap(array, limit, asyncCallback);
  }

  /**
   * @param {string} url
   * @param {((err: any, res: any, body: any) => void) | null} [cb]
   */
  baseRequest(url, cb) {
    return baseRequest(url, cb);
  }

  /**
   * @param {string} url
   * @returns {Promise<string>}
   */
  fetchText(url) {
    return fetchText(url);
  }

  /**
   * @param {string} java
   * @returns {Promise<{ run: boolean, message?: any }>}
   */
  checkJava(java) {
    return jvmUtils.checkJava(java, this.client);
  }

  /**
   * @param {string} url
   * @param {string} directory
   * @param {string} name
   * @param {boolean} retry
   * @param {string} type
   * @returns {Promise<any>}
   */
  downloadAsync(url, directory, name, retry, type) {
    return downloadFileAsync(url, directory, name, retry, type, {
      client: this.client,
      options: this.options
    });
  }

  /**
   * Vérifie qu'un chemin cible reste confiné dans baseDir (protection path traversal).
   * @param {string} baseDir
   * @param {string} targetPath
   * @returns {string}
   */
  _assertSubPath(baseDir, targetPath) {
    const resolvedBase = path.resolve(baseDir);
    const resolvedTarget = path.resolve(resolvedBase, targetPath);
    const normBase = process.platform === 'win32' ? resolvedBase.toLowerCase() : resolvedBase;
    const normTarget = process.platform === 'win32' ? resolvedTarget.toLowerCase() : resolvedTarget;
    if (!normTarget.startsWith(normBase + path.sep) && normTarget !== normBase) {
      throw new Error(`Chemin hors-périmètre bloqué : ${targetPath}`);
    }
    return resolvedTarget;
  }

  /**
   * @param {string} hash
   * @param {string} file
   * @returns {Promise<boolean>}
   */
  checkSum(hash, file) {
    return checkSum(hash, file, this.client);
  }

  /**
   * @param {string} filePath
   * @param {number} [expectedSize]
   * @param {string} [expectedSha1]
   * @param {{ fastSizeOnly?: boolean }} [opts]
   * @returns {Promise<boolean>}
   */
  verifyFileFast(filePath, expectedSize, expectedSha1, opts) {
    return verifyFileFast(filePath, expectedSize, expectedSha1, opts, {
      options: this.options,
      checkSumFn: (hash, file) => this.checkSum(hash, file)
    });
  }

  /**
   * @returns {Promise<any>}
   */
  getVersion() {
    return new Promise(async (resolve, reject) => {
      const versionJsonPath = this.options.overrides.versionJson || path.join(this.options.directory, `${this.options.version.number}.json`);
      if (await existsAsync(versionJsonPath)) {
        try {
          this.version = JSON.parse(await fs.promises.readFile(versionJsonPath, 'utf8'));
          return resolve(this.version);
        } catch (parseErr) {
          this.client?.emit('debug', `[Gens-Core]: Corrupted version JSON at ${versionJsonPath}: ${parseErr}`);
          if (this.options.offline) {
            return reject(new Error(`Version JSON corrompu en mode hors-ligne : ${versionJsonPath}`));
          }
        }
      }

      const cache = this.options.cache ? `${this.options.cache}/json` : `${this.options.root}/cache/json`;
      const cachedVersionJson = path.join(cache, `${this.options.version.number}.json`);
      const baseVersionJson = path.join(this.options.root, 'versions', `${this.options.version.number}`, `${this.options.version.number}.json`);

      for (const candidate of [baseVersionJson, cachedVersionJson]) {
        if (await existsAsync(candidate)) {
          try {
            this.version = JSON.parse(await fs.promises.readFile(candidate, 'utf8'));
            return resolve(this.version);
          } catch (_) { /* ignore corrupted cache and refetch */ }
        }
      }

      if (this.options.offline) {
        return reject(new Error(`Métadonnées de version ${this.options.version.number} introuvables localement en mode hors-ligne.`));
      }

      const manifestUrls = [
        'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
        `${this.options.overrides.url.meta}/mc/game/version_manifest.json`
      ];

      try {
        if (!(await existsAsync(cache))) {
          await fs.promises.mkdir(cache, { recursive: true });
        }
        let parsed = null;
        let manifestBody = null;
        for (const url of manifestUrls) {
          try {
            manifestBody = await this.fetchText(url);
            parsed = JSON.parse(manifestBody);
            if (parsed && parsed.versions) break;
          } catch (_) { /* try fallback */ }
        }
        if (!parsed || !parsed.versions) {
          throw new Error('Failed to fetch version_manifest.json from Mojang mirrors');
        }
        await writeFileAtomic(path.join(cache, 'version_manifest.json'), manifestBody || '');
        const desiredVersion = Object.values(parsed.versions).find((/** @type {any} */ version) => version.id === this.options.version.number);
        if (desiredVersion) {
          const versionBody = await this.fetchText(desiredVersion.url);
          if (desiredVersion.sha1) {
            const actualVerSha1 = crypto.createHash('sha1').update(versionBody, 'utf8').digest('hex').toLowerCase();
            if (actualVerSha1 !== String(desiredVersion.sha1).trim().toLowerCase()) {
              throw new Error(`SHA-1 mismatch for version metadata ${this.options.version.number}`);
            }
          }
          await writeFileAtomic(path.join(cache, `${this.options.version.number}.json`), versionBody);
          this.version = JSON.parse(versionBody);
          return resolve(this.version);
        } else {
          throw new Error(`Failed to find version ${this.options.version.number} in version_manifest.json`);
        }
      } catch (e) {
        try {
          if (await existsAsync(cachedVersionJson)) {
            this.version = JSON.parse(await fs.promises.readFile(cachedVersionJson, 'utf8'));
            return resolve(this.version);
          }
        } catch (err) { }
        return reject(e);
      }
    })
  }

  /**
   * @returns {Promise<any>}
   */
  async getJar() {
    const jarPath = path.join(this.options.directory, `${this.options.version.custom ? this.options.version.custom : this.options.version.number}.jar`);
    const clientSha1 = this.version?.downloads?.client?.sha1;
    if ((await existsAsync(jarPath)) && (!clientSha1 || await this.checkSum(clientSha1, jarPath))) {
      this.client.emit('debug', '[Gens-Core]: Using existing version jar');
    } else {
      const vanillaJar = this.options.version.custom ? path.join(this.options.root, 'versions', this.options.version.number, `${this.options.version.number}.jar`) : null;
      if (vanillaJar && (await existsAsync(vanillaJar)) && (!clientSha1 || await this.checkSum(clientSha1, vanillaJar))) {
        this.client.emit('debug', '[Gens-Core]: Reusing vanilla version jar for custom loader');
        await fs.promises.mkdir(this.options.directory, { recursive: true });
        await fs.promises.copyFile(vanillaJar, jarPath);
      } else if (this.version?.downloads?.client?.url) {
        const dlRes = await this.downloadAsync(this.version.downloads.client.url, this.options.directory, `${this.options.version.custom ? this.options.version.custom : this.options.version.number}.jar`, true, 'version-jar');
        if (dlRes && dlRes.failed) {
          throw new Error(`Failed to download client jar (${dlRes.asset?.url || this.version.downloads.client.url})`);
        }
        if (clientSha1 && !(await this.checkSum(clientSha1, jarPath))) {
          try { await fs.promises.unlink(jarPath); } catch (_) {}
          throw new Error(`Client jar SHA-1 verification failed for ${this.options.version.number}`);
        }
      }
    }
    await fs.promises.mkdir(this.options.directory, { recursive: true });
    await writeFileAtomic(path.join(this.options.directory, `${this.options.version.number}.json`), JSON.stringify(this.version, null, 4));
    return this.client.emit('debug', '[Gens-Core]: Downloaded version jar and wrote version json');
  }

  /**
   * @returns {string}
   */
  getAssetIndexName() {
    if (this.options.overrides && typeof this.options.overrides.assetIndex === 'string' && this.options.overrides.assetIndex.trim()) {
      const overrideIdx = this.options.overrides.assetIndex.trim();
      if (overrideIdx === '.' || overrideIdx.includes('..') || /[/\\:\x00-\x1f]/.test(overrideIdx)) {
        throw new Error(`Invalid overrides.assetIndex: ${overrideIdx}`);
      }
      return overrideIdx;
    }
    const assetDirectory = path.resolve((this.options.overrides && this.options.overrides.assetRoot) || path.join(this.options.root, 'assets'));
    const defaultId = (this.version && this.version.assetIndex && this.version.assetIndex.id) || this.options.version.number;
    const customId = this.options.version && this.options.version.custom;
    if (fs.existsSync(path.join(assetDirectory, 'indexes', `${defaultId}.json`))) return defaultId;
    if (customId && fs.existsSync(path.join(assetDirectory, 'indexes', `${customId}.json`))) return customId;
    return defaultId;
  }

  /**
   * @returns {Promise<string>}
   */
  async getAssetIndexNameAsync() {
    if (this.options.overrides && typeof this.options.overrides.assetIndex === 'string' && this.options.overrides.assetIndex.trim()) {
      const overrideIdx = this.options.overrides.assetIndex.trim();
      if (overrideIdx === '.' || overrideIdx.includes('..') || /[/\\:\x00-\x1f]/.test(overrideIdx)) {
        throw new Error(`Invalid overrides.assetIndex: ${overrideIdx}`);
      }
      return overrideIdx;
    }
    const assetDirectory = path.resolve((this.options.overrides && this.options.overrides.assetRoot) || path.join(this.options.root, 'assets'));
    const defaultId = (this.version && this.version.assetIndex && this.version.assetIndex.id) || this.options.version.number;
    const customId = this.options.version && this.options.version.custom;
    if (await existsAsync(path.join(assetDirectory, 'indexes', `${defaultId}.json`))) return defaultId;
    if (customId && await existsAsync(path.join(assetDirectory, 'indexes', `${customId}.json`))) return customId;
    return defaultId;
  }

  async getAssets() {
    const assetDirectory = path.resolve(this.options.overrides.assetRoot || path.join(this.options.root, 'assets'))
    const assetId = await this.getAssetIndexNameAsync()
    const indexJsonPath = path.join(assetDirectory, 'indexes', `${assetId}.json`)
    if (!(await existsAsync(indexJsonPath))) {
      if (this.options.offline) {
        this.client.emit('debug', `[Gens-Core]: Asset index ${assetId}.json absent en mode hors-ligne, téléchargement ignoré.`)
        return
      }
      const dlIdxRes = await this.downloadAsync(this.version.assetIndex.url, path.join(assetDirectory, 'indexes'), `${assetId}.json`, true, 'asset-json')
      if (dlIdxRes && dlIdxRes.failed) {
        throw new Error(`Failed to download asset index ${assetId}.json`)
      }
      const expectedIdxSha1 = this.version?.assetIndex?.sha1
      if (expectedIdxSha1 && !(await this.checkSum(expectedIdxSha1, indexJsonPath))) {
        try { await fs.promises.unlink(indexJsonPath) } catch (_) {}
        throw new Error(`Asset index SHA-1 verification failed for ${assetId}.json`)
      }
    }

    if (!(await existsAsync(indexJsonPath))) return

    let index;
    try {
      index = JSON.parse(await fs.promises.readFile(indexJsonPath, { encoding: 'utf8' }))
    } catch (e) {
      if (this.options.offline) {
        this.client.emit('debug', `[Gens-Core]: Asset index corrompu en mode hors-ligne : ${e}`)
        return
      }
      throw e
    }
    const assetKeys = Object.keys(index?.objects || {})
    let counter = 0

    this.client.emit('progress', {
      type: 'assets',
      task: 0,
      total: assetKeys.length
    })

    if (this.options.offline) {
      // Hors-ligne : aucune requête réseau, ni vérification/téléchargement bloquant
      return
    }

    await pMap(assetKeys, 16, async (/** @type {string} */ asset) => {
      if (this.client && this.client.aborted) throw new Error("Launch aborted by user");
      const assetObj = index.objects[asset]
      const hash = assetObj.hash
      const expectedSize = assetObj.size
      const subhash = hash.substring(0, 2)
      const subAsset = path.join(assetDirectory, 'objects', subhash)
      const assetFile = path.join(subAsset, hash)

      if (!(await this.verifyFileFast(assetFile, expectedSize, hash))) {
        const dl1 = await this.downloadAsync(`${this.options.overrides.url.resource}/${subhash}/${hash}`, subAsset, hash, true, 'assets')
        if (dl1?.failed || !(await this.checkSum(hash, assetFile))) {
          const dl2 = await this.downloadAsync(`${this.options.overrides.url.resource}/${subhash}/${hash}`, subAsset, hash, true, 'assets')
          if (dl2?.failed || !(await this.checkSum(hash, assetFile))) {
            throw new Error(`Failed to verify or download asset ${asset} (${hash})`)
          }
        }
      }
      counter++
      this.client.emit('progress', {
        type: 'assets',
        task: counter,
        total: assetKeys.length
      })
    })


    if (this.isLegacy()) { counter = 0;
      if (await existsAsync(path.join(assetDirectory, 'legacy'))) {
        this.client.emit('debug', '[Gens-Core]: The \'legacy\' directory is no longer used as Minecraft looks ' +
          'for the resouces folder regardless of what is passed in the assetDirecotry launch option. I\'d ' +
          `recommend removing the directory (${path.join(assetDirectory, 'legacy')})`)
      }

      const legacyDirectory = path.join(this.options.root, 'resources')
      this.client.emit('debug', `[Gens-Core]: Copying assets over to ${legacyDirectory}`)

      this.client.emit('progress', {
        type: 'assets-copy',
        task: 0,
        total: Object.keys(index.objects).length
      })

      await pMap(Object.keys(index.objects), 16, async (/** @type {string} */ asset) => {
        if (this.client && this.client.aborted) throw new Error("Launch aborted by user");
        const hash = index.objects[asset].hash
        const subhash = hash.substring(0, 2)
        const subAsset = path.join(assetDirectory, 'objects', subhash)
        const targetLegacyPath = this._assertSubPath(legacyDirectory, asset)
        const targetLegacyDir = path.dirname(targetLegacyPath)

        if (!(await existsAsync(targetLegacyDir))) {
          await fs.promises.mkdir(targetLegacyDir, { recursive: true })
        }

        if (!(await existsAsync(targetLegacyPath))) {
          await fs.promises.copyFile(path.join(subAsset, hash), targetLegacyPath)
        }
        counter++
        this.client.emit('progress', {
          type: 'assets-copy',
          task: counter,
          total: Object.keys(index.objects).length
        })
      })
    }


    this.client.emit('debug', '[Gens-Core]: Downloaded assets')
  }

  /**
   * @param {any} versionStr
   * @returns {{ major: number, minor: number, patch: number }}
   */
  parseVersion(versionStr) {
    return jvmUtils.parseVersion(versionStr);
  }

  /**
   * @param {any} v1
   * @param {any} v2
   * @returns {number}
   */
  compareVersion(v1, v2) {
    return jvmUtils.compareVersion(v1, v2);
  }

  /**
   * @param {number} targetMajor
   * @param {number} targetMinor
   * @param {number} [targetPatch=0]
   * @returns {boolean}
   */
  isVersionAtLeast(targetMajor, targetMinor, targetPatch = 0) {
    const rawId = (this.options && this.options.version && this.options.version.number)
      || (this.version && (this.version.inheritsFrom || this.version.id));
    if (!rawId) return false;
    const parsed = this.parseVersion(rawId);
    return this.compareVersion(parsed, { major: targetMajor, minor: targetMinor, patch: targetPatch }) >= 0;
  }

  /**
   * @param {any} lib
   * @returns {boolean}
   */
  parseRule(lib) {
    return jvmUtils.parseRule(lib, this.getOS());
  }

  /**
   * @returns {Promise<string>}
   */
  async getNatives() {
    const nativeDirectory = path.resolve(this.options.overrides.natives || path.join(this.options.root, 'natives', this.version.id))

    if (this.isVersionAtLeast(1, 19)) {
      await fs.promises.mkdir(nativeDirectory, { recursive: true });
      await fs.promises.mkdir(path.join(nativeDirectory, 'java'), { recursive: true });
      await fs.promises.mkdir(path.join(nativeDirectory, 'jna'), { recursive: true });
      await fs.promises.mkdir(path.join(nativeDirectory, 'lwjgl'), { recursive: true });
      await fs.promises.mkdir(path.join(nativeDirectory, 'netty'), { recursive: true });
      return nativeDirectory;
    }

    const stampFile = path.join(nativeDirectory, '.natives_complete');
    let hasNatives = false;
    if (await existsAsync(stampFile)) {
      hasNatives = true;
    }
    if (!hasNatives) {
      await fs.promises.mkdir(nativeDirectory, { recursive: true })

      const natives = async () => {
        /** @type {any[]} */
        const natives = []
        await pMap(this.version.libraries, 16, async (/** @type {any} */ lib) => {
          if (this.client && this.client.aborted) throw new Error("Launch aborted by user");
          if (!lib.downloads || !lib.downloads.classifiers) return
          if (this.parseRule(lib)) return

          const native = this.getOS() === 'osx'
            ? lib.downloads.classifiers['natives-osx'] || lib.downloads.classifiers['natives-macos']
            : lib.downloads.classifiers[`natives-${this.getOS()}`]

          natives.push(native)
        })
        return natives
      }
      const stat = await natives()
      let counter = 0
      let nativesAllOk = true

      this.client.emit('progress', {
        type: 'natives',
        task: 0,
        total: stat.length
      })

      let extractQueue = Promise.resolve();
      const serializeExtract = (/** @type {() => Promise<void>} */ fn) => {
        const next = extractQueue.then(fn, fn);
        extractQueue = next.catch(() => {});
        return next;
      };

      await pMap(stat, 16, async (/** @type {any} */ native) => {
        if (this.client && this.client.aborted) throw new Error("Launch aborted by user");
        if (!native) return
        const name = native.path.split('/').pop()
        const nativeFile = this._assertSubPath(nativeDirectory, name)
        if (this.options.offline) {
          if (await existsAsync(nativeFile)) {
            try {
              await serializeExtract(() => new Zip(nativeFile).extractAllTo(nativeDirectory, true, { skipMetaInf: true }))
            } finally {
              if (await existsAsync(nativeFile)) {
                try { await fs.promises.unlink(nativeFile) } catch (_) {}
              }
            }
          }
          counter++
          this.client.emit('progress', {
            type: 'natives',
            task: counter,
            total: stat.length
          })
          return
        }
        if (!(await existsAsync(nativeFile)) || !await this.checkSum(native.sha1, nativeFile)) {
          const dl = await this.downloadAsync(native.url, nativeDirectory, name, true, 'natives')
          if (dl?.failed || !(await this.checkSum(native.sha1, nativeFile))) {
            nativesAllOk = false
            throw new Error(`Failed to download/verify native library ${name}`)
          }
        }
        try {
          await serializeExtract(() => new Zip(nativeFile).extractAllTo(nativeDirectory, true, { skipMetaInf: true }))
        } catch (e) {
          nativesAllOk = false
          throw e
        } finally {
          if (await existsAsync(nativeFile)) {
            try { await fs.promises.unlink(nativeFile) } catch (_) {}
          }
        }
        counter++
        this.client.emit('progress', {
          type: 'natives',
          task: counter,
          total: stat.length
        })
      })
      if (nativesAllOk && !this.options.offline) {
        await fs.promises.writeFile(stampFile, Date.now().toString(), 'utf8');
        this.client.emit('debug', '[Gens-Core]: Downloaded and extracted natives')
      }
    }


    this.client.emit('debug', `[Gens-Core]: Set native path to ${nativeDirectory}`)

    return nativeDirectory
  }

  fwAddArgs() {
    const forgeWrapperAgrs = [
      `-Dforgewrapper.librariesDir=${path.resolve(this.options.overrides.libraryRoot || path.join(this.options.root, 'libraries'))}`,
      `-Dforgewrapper.installer=${this.options.forge}`,
      `-Dforgewrapper.minecraft=${this.options.mcPath}`
    ]
    this.options.customArgs
      ? this.options.customArgs = this.options.customArgs.concat(forgeWrapperAgrs)
      : this.options.customArgs = forgeWrapperAgrs
  }

  /**
   * @param {any} json
   * @returns {boolean}
   */
  isModernForge(json) {
    if (!json) return false;
    const verStr = json.inheritsFrom || (typeof json.id === 'string' ? json.id.split('-')[0] : '');
    if (!verStr) return false;
    const parts = verStr.split('.');
    if (parts[0] === '1') {
      const idParts = String(json.id || '').split('.');
      return parseInt(parts[1]) >= 13 || (parts[1] === '12' && parts[2] === '2' && !(idParts[idParts.length - 1] === '2847'));
    }
    return parseInt(parts[0]) >= 2;
  }

  /**
   * @returns {Promise<any>}
   */
  async getForgedWrapped() {
    return resolveForgedWrapped(this);
  }

  /**
   * @param {string} directory
   * @param {any[]} libraries
   * @param {string} eventName
   * @returns {Promise<string[]>}
   */
  async downloadToDirectory(directory, libraries, eventName) {
    let counter = 0
    const activeLibraries = (libraries || []).filter((/** @type {any} */ lib) => lib && !this.parseRule(lib))

    const results = await pMap(activeLibraries, 12, async (/** @type {any} */ library) => {
      if (this.client && this.client.aborted) throw new Error("Launch aborted by user");
      const lib = library.name.split(':')
      const libNameClean = lib[1] || ''
      const libVersionClean = (lib[2] || '').replace(/@jar$/i, '')
      const libClassifier = lib[3] ? `-${lib[3].replace(/@jar$/i, '')}` : ''

      /** @type {string} */
      let jarPath = ''
      /** @type {string} */
      let name = ''
      if (library.downloads && library.downloads.artifact && library.downloads.artifact.path) {
        name = library.downloads.artifact.path.split('/')[library.downloads.artifact.path.split('/').length - 1]
        jarPath = path.join(directory, this.popString(library.downloads.artifact.path))
      } else {
        name = `${libNameClean}-${libVersionClean}${libClassifier}.jar`
        jarPath = path.join(directory, `${lib[0].replace(/\./g, '/')}/${libNameClean}/${libVersionClean}`)
      }

      /** @param {any} libItem */
      const downloadLibrary = async (libItem) => {
        if (libItem.url) {
          const baseUrl = libItem.url.endsWith('/') ? libItem.url : `${libItem.url}/`
          const url = `${baseUrl}${lib[0].replace(/\./g, '/')}/${libNameClean}/${libVersionClean}/${name}`
          return await this.downloadAsync(url, jarPath, name, true, eventName)
        } else if (libItem.downloads && libItem.downloads.artifact && libItem.downloads.artifact.url) {
          return await this.downloadAsync(libItem.downloads.artifact.url, jarPath, name, true, eventName)
        }
        return { failed: false, asset: null }
      }

      const libFile = this._assertSubPath(directory, path.join(jarPath, name))
      jarPath = path.dirname(libFile)
      const artifact = library.downloads && library.downloads.artifact
      const expectedSize = artifact ? artifact.size : undefined
      const expectedSha1 = artifact ? artifact.sha1 : undefined

      if (this.options.offline) {
        const exists = await existsAsync(libFile);
        counter++
        this.client.emit('progress', {
          type: eventName,
          task: counter,
          total: activeLibraries.length
        })
        return exists ? `${jarPath}${path.sep}${name}` : null
      }

      if (!(await this.verifyFileFast(libFile, expectedSize, expectedSha1))) {
        const dl1 = await downloadLibrary(library)
        if (dl1?.failed || (expectedSha1 && !(await this.checkSum(expectedSha1, libFile)))) {
          const dl2 = await downloadLibrary(library)
          if (dl2?.failed || (expectedSha1 && !(await this.checkSum(expectedSha1, libFile))) || !(await existsAsync(libFile))) {
            throw new Error(`Failed to download/verify library ${library.name}`)
          }
        }
      }

      counter++
      this.client.emit('progress', {
        type: eventName,
        task: counter,
        total: activeLibraries.length
      })
      return `${jarPath}${path.sep}${name}`
    })

    return /** @type {string[]} */ (results.filter((p) => Boolean(p)))
  }

  /**
   * @param {any} [classJson]
   * @returns {Promise<string[]>}
   */
  async getClasses(classJson) {
    /** @type {string[]} */
    let libs = []

    const libraryDirectory = path.resolve(this.options.overrides.libraryRoot || path.join(this.options.root, 'libraries'))

    if (classJson) {
      if (classJson.mavenFiles) {
        await this.downloadToDirectory(libraryDirectory, classJson.mavenFiles, 'classes-maven-custom')
      }
      if (Array.isArray(classJson.libraries)) {
        libs = await this.downloadToDirectory(libraryDirectory, classJson.libraries, 'classes-custom')
      }
    }

    const parsed = this.version.libraries.filter((/** @type {any} */ lib) => {
      if (lib.downloads && lib.downloads.artifact && !this.parseRule(lib)) {
        /** @param {any} n */
        const getLibIdentity = (n) => { const p = String(n || '').split(':'); return `${p[0] || ''}:${p[1] || ''}:${p[3] || ''}`; };
        if (!classJson || !Array.isArray(classJson.libraries) || !classJson.libraries.some((/** @type {any} */ l) => l && getLibIdentity(l.name) === getLibIdentity(lib.name))) {
          return true
        }
      }
      return false
    })

    libs = libs.concat((await this.downloadToDirectory(libraryDirectory, parsed, 'classes')))
    libs = libs.filter(l => !l.includes('-installer.jar') && !l.includes('forge-installer'))


    this.client.emit('debug', '[Gens-Core]: Collected class paths')
    return libs
  }

  /**
   * @param {string} p
   * @returns {string}
   */
  popString(p) {
    return p.split('/').slice(0, -1).join('/')
  }

  /**
   * @param {any} array
   * @returns {any[]}
   */
  cleanUp(array) {
    return [...new Set(Object.values(array).filter(value => value !== null))]
  }

  formatQuickPlay() {
    return jvmUtils.formatQuickPlay(this.options, this.client);
  }

  /**
   * @param {any} [modification]
   * @returns {Promise<string[]>}
   */
  async getLaunchOptions(modification) {
    return jvmUtils.buildLaunchOptions({
      version: this.version,
      options: this.options,
      client: this.client,
      isLegacy: this.isLegacy(),
      assetIndexName: await this.getAssetIndexNameAsync(),
      quickPlayArgs: this.options.quickPlay ? this.formatQuickPlay() : null,
      modification
    });
  }

  /**
   * @param {any} modifyJson
   * @param {string} nativePath
   * @returns {Promise<string[]>}
   */
  async getJVMArgs(modifyJson, nativePath) {
    return jvmUtils.buildJVMArgs({
      version: this.version,
      options: this.options,
      modifyJson,
      nativePath,
      isAtLeast26: this.isVersionAtLeast(26, 0),
      legacyJvmArg: await this.getJVM(),
      assetIndexName: await this.getAssetIndexNameAsync()
    });
  }

  async getJVM() {
    return jvmUtils.getJVMDefaultArg(this.getOS());
  }

  isLegacy() {
    return this.version.assets === 'legacy' || this.version.assets === 'pre-1.6'
  }

  getOS() {
    return jvmUtils.getOS(this.options);
  }

  getMemory() {
    return jvmUtils.getMemory(this.options, this.client);
  }

  /**
   * @param {any} [options]
   */
  async extractPackage(options = this.options) {
    if (options.clientPackage.startsWith('http')) {
      await this.downloadAsync(options.clientPackage, options.root, 'clientPackage.zip', true, 'client-package')
      options.clientPackage = path.join(options.root, 'clientPackage.zip')
    }
    await new Zip(options.clientPackage).extractAllTo(options.root, true)
    if (options.removePackage) {
      if (await existsAsync(options.clientPackage)) await fs.promises.unlink(options.clientPackage)
    }

    return this.client.emit('package-extract', true)
  }
}

module.exports = Handler
