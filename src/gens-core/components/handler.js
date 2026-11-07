// @ts-check
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const child = require('child_process')

const yauzl = require('yauzl-promise');
const { pipeline } = require('stream/promises');

class Zip {
  /**
   * @param {string} zipPath
   */
  constructor(zipPath) {
    this.zipPath = zipPath;
  }
  
  /**
   * @param {string} dest
   * @param {boolean} [overwrite]
   */
  async extractAllTo(dest, overwrite) {
    const zipfile = await yauzl.open(this.zipPath);
    const resolvedTarget = path.resolve(dest);
    try {
      for await (const entry of zipfile) {
        const entryName = entry.filename || entry.fileName;
        const destPath = path.join(dest, entryName);
        const resDest = path.resolve(destPath);
        if (!resDest.startsWith(resolvedTarget + path.sep) && resDest !== resolvedTarget) continue;
        if (entryName.endsWith('/')) {
          await fs.promises.mkdir(destPath, { recursive: true });
        } else {
          await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
          const readStream = await entry.openReadStream();
          const writeStream = fs.createWriteStream(destPath);
          await pipeline(readStream, writeStream);
        }
      }
    } finally {
      await zipfile.close();
    }
  }
  
  /**
   * @param {string} fileName
   * @returns {Promise<string | null>}
   */
  async readAsText(fileName) {
    try {
      const zipfile = await yauzl.open(this.zipPath);
      try {
        for await (const entry of zipfile) {
          if (entry.filename === fileName) {
            const readStream = await entry.openReadStream();
            let data = '';
            for await (const chunk of readStream) {
              data += chunk;
            }
            return data;
          }
        }
        return null;
      } finally {
        await zipfile.close();
      }
    } catch (e) {
      return null;
    }
  }
  
  /**
   * @param {string} fileName
   * @returns {boolean}
   */
  getEntry(fileName) {
    return true;
  }
}

/**
 * Executes an async callback on an array of items with bounded concurrency.
 * @template T, R
 * @param {T[]} array
 * @param {number} limit
 * @param {(item: T, index: number, array: T[]) => Promise<R> | R} asyncCallback
 * @returns {Promise<R[]>}
 */
async function pMap(array, limit, asyncCallback) {
  /** @type {Promise<R>[]} */
  const results = [];
  /** @type {Promise<any>[]} */
  const executing = [];
  for (let i = 0; i < array.length; i++) {
    const p = Promise.resolve().then(() => asyncCallback(array[i], i, array));
    results.push(p);
    if (limit <= array.length) {
      const e = p.finally(() => {
        const index = executing.indexOf(e);
        if (index !== -1) executing.splice(index, 1);
      });
      e.catch(() => {});
      executing.push(e);
      if (executing.length >= limit) {
        await Promise.race(executing);
      }
    }
  }
  return Promise.all(results);
}

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
  async baseRequest(url, cb) {
    try {
      const res = await fetch(url, { method: 'HEAD' });
      if (cb) cb(null, { statusCode: res.status }, null);
    } catch (e) {
      if (cb) cb(e, null, null);
    }
  }

  /**
   * @param {string} url
   * @returns {Promise<string>}
   */
  async fetchText(url) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.statusText);
      return await res.text();
    } catch (e) {
      throw e;
    }
  }

  /**
   * @param {string} java
   * @returns {Promise<{ run: boolean, message?: any }>}
   */
  checkJava(java) {
    return new Promise(resolve => {
      let javaConsole = java;
      if (typeof javaConsole === 'string' && process.platform === 'win32') {
        if (javaConsole.toLowerCase().endsWith('javaw.exe')) {
          javaConsole = javaConsole.slice(0, -9) + 'java.exe';
        } else if (javaConsole.toLowerCase().endsWith('javaw')) {
          javaConsole = javaConsole.slice(0, -5) + 'java';
        }
      }

      child.execFile(javaConsole, ['-version'], (error, stdout, stderr) => {
        if (error) {
          resolve({
            run: false,
            message: error
          })
        } else {
          const verMatch = (stderr && stderr.match(/"(.*?)"/)) || (stdout && stdout.match(/"(.*?)"/));
          this.client.emit('debug', `[Gens-Core]: Using Java version ${verMatch ? verMatch[1] : 'unknown'} ${stderr && stderr.includes('64-Bit') ? '64-bit' : '32-Bit'}`)
          resolve({
            run: true
          })
        }
      })
    })
  }

  /**
   * @param {string} url
   * @param {string} directory
   * @param {string} name
   * @param {boolean} retry
   * @param {string} type
   * @returns {Promise<any>}
   */
  async downloadAsync(url, directory, name, retry, type) {
    if (this.client && this.client.aborted) throw new Error("Launch aborted by user");
    if (this.options.offline) return path.join(directory, name);
    if (!(fs.existsSync(directory))) {
      await fs.promises.mkdir(directory, { recursive: true });
    }
    /** @type {Response} */
    let response;
    try {
      response = await fetch(url);
    } catch (e) {
      if (retry) return await this.downloadAsync(url, directory, name, false, type);
      return { failed: true, asset: null };
    }

    if (!response.ok) {
      this.client.emit('debug', `[Gens-Core]: Failed to download ${url} due to: ${response.statusText}`);
      if (retry) return await this.downloadAsync(url, directory, name, false, type);
      return { failed: true, asset: null };
    }

    const totalBytes = parseInt(response.headers.get('content-length') || '0');
    let receivedBytes = 0;

    const dest = fs.createWriteStream(path.join(directory, name));
    const { Readable } = require('stream');
    if (!response.body) {
      dest.destroy();
      return { failed: true, asset: null };
    }
    const bodyStream = Readable.fromWeb(/** @type {any} */(response.body));

    bodyStream.on('data', chunk => {
      if (this.client && this.client.aborted) {
        dest.destroy(new Error("Launch aborted by user"));
        bodyStream.destroy();
        return;
      }
      receivedBytes += chunk.length;
      this.client.emit('download-status', {
        name: name, type: type, current: receivedBytes, total: totalBytes
      });
    });

    bodyStream.on('error', err => dest.destroy(err));
    bodyStream.pipe(dest);

    return new Promise((resolve, reject) => {
      dest.once('finish', () => {
        this.client.emit('download', name);
        resolve({ failed: false, asset: null });
      });
      dest.on('error', async (e) => {
        if (fs.existsSync(path.join(directory, name))) await fs.promises.unlink(path.join(directory, name));
        if (retry && (!this.client || !this.client.aborted)) return resolve(await this.downloadAsync(url, directory, name, false, type));
        resolve({ failed: true, asset: null });
      });
    });
  }

  /**
   * @param {string} hash
   * @param {string} file
   * @returns {Promise<boolean>}
   */
  checkSum(hash, file) {
    return new Promise((resolve) => {
      const hashStream = crypto.createHash('sha1');
      const fileStream = fs.createReadStream(file);

      /** @param {any} err */
      const onError = (err) => {
        this.client.emit('debug', `[Gens-Core]: Failed to check file hash due to ${err}`);
        resolve(false);
      };

      fileStream.on('error', onError);
      hashStream.on('error', onError);

      hashStream.on('finish', () => {
        const sum = hashStream.read()?.toString('hex');
        resolve(hash === sum);
      });

      fileStream.pipe(hashStream);
    });
  }

  /**
   * @param {string} filePath
   * @param {number} [expectedSize]
   * @param {string} [expectedSha1]
   * @returns {Promise<boolean>}
   */
  async verifyFileFast(filePath, expectedSize, expectedSha1) {
    try {
      const stat = await fs.promises.stat(filePath);
      if (typeof expectedSize === 'number' && expectedSize > 0) {
        return stat.size === expectedSize;
      }
      if (expectedSha1) {
        return await this.checkSum(expectedSha1, filePath);
      }
      return stat.size > 0;
    } catch (_) {
      return false;
    }
  }

  /**
   * @returns {Promise<any>}
   */
  getVersion() {
    return new Promise(async (resolve, reject) => {
      const versionJsonPath = this.options.overrides.versionJson || path.join(this.options.directory, `${this.options.version.number}.json`);
      if (fs.existsSync(versionJsonPath)) {
        this.version = JSON.parse(await fs.promises.readFile(versionJsonPath, 'utf8'));
        return resolve(this.version);
      }

      const cache = this.options.cache ? `${this.options.cache}/json` : `${this.options.root}/cache/json`;
      const cachedVersionJson = path.join(cache, `${this.options.version.number}.json`);
      const baseVersionJson = path.join(this.options.root, 'versions', `${this.options.version.number}`, `${this.options.version.number}.json`);

      for (const candidate of [baseVersionJson, cachedVersionJson]) {
        if (fs.existsSync(candidate)) {
          try {
            this.version = JSON.parse(await fs.promises.readFile(candidate, 'utf8'));
            return resolve(this.version);
          } catch (_) { /* ignore corrupted cache and refetch */ }
        }
      }

      const manifestUrls = [
        'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
        `${this.options.overrides.url.meta}/mc/game/version_manifest.json`
      ];

      try {
        if (!(fs.existsSync(cache))) {
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
        await fs.promises.writeFile(path.join(cache, 'version_manifest.json'), manifestBody || '');
        const desiredVersion = Object.values(parsed.versions).find((/** @type {any} */ version) => version.id === this.options.version.number);
        if (desiredVersion) {
          const versionBody = await this.fetchText(desiredVersion.url);
          await fs.promises.writeFile(path.join(cache, `${this.options.version.number}.json`), versionBody);
          this.version = JSON.parse(versionBody);
          return resolve(this.version);
        } else {
          throw new Error(`Failed to find version ${this.options.version.number} in version_manifest.json`);
        }
      } catch (e) {
        try {
          if (fs.existsSync(cachedVersionJson)) {
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
    if (fs.existsSync(jarPath) && (!clientSha1 || await this.checkSum(clientSha1, jarPath))) {
      this.client.emit('debug', '[Gens-Core]: Using existing version jar');
    } else {
      const vanillaJar = this.options.version.custom ? path.join(this.options.root, 'versions', this.options.version.number, `${this.options.version.number}.jar`) : null;
      if (vanillaJar && fs.existsSync(vanillaJar) && (!clientSha1 || await this.checkSum(clientSha1, vanillaJar))) {
        this.client.emit('debug', '[Gens-Core]: Reusing vanilla version jar for custom loader');
        await fs.promises.mkdir(this.options.directory, { recursive: true });
        await fs.promises.copyFile(vanillaJar, jarPath);
      } else if (this.version?.downloads?.client?.url) {
        await this.downloadAsync(this.version.downloads.client.url, this.options.directory, `${this.options.version.custom ? this.options.version.custom : this.options.version.number}.jar`, true, 'version-jar');
      }
    }
    await fs.promises.mkdir(this.options.directory, { recursive: true });
    await fs.promises.writeFile(path.join(this.options.directory, `${this.options.version.number}.json`), JSON.stringify(this.version, null, 4));
    return this.client.emit('debug', '[Gens-Core]: Downloaded version jar and wrote version json');
  }

  /**
   * @returns {string}
   */
  getAssetIndexName() {
    if (this.options.overrides && this.options.overrides.assetIndex) return this.options.overrides.assetIndex;
    const assetDirectory = path.resolve((this.options.overrides && this.options.overrides.assetRoot) || path.join(this.options.root, 'assets'));
    const defaultId = (this.version && this.version.assetIndex && this.version.assetIndex.id) || this.options.version.number;
    const customId = this.options.version && this.options.version.custom;
    if (fs.existsSync(path.join(assetDirectory, 'indexes', `${defaultId}.json`))) return defaultId;
    if (customId && fs.existsSync(path.join(assetDirectory, 'indexes', `${customId}.json`))) return customId;
    return defaultId;
  }

  async getAssets() {
    const assetDirectory = path.resolve(this.options.overrides.assetRoot || path.join(this.options.root, 'assets'))
    const assetId = this.getAssetIndexName()
    if (!(fs.existsSync(path.join(assetDirectory, 'indexes', `${assetId}.json`)))) {
      await this.downloadAsync(this.version.assetIndex.url, path.join(assetDirectory, 'indexes'), `${assetId}.json`, true, 'asset-json')
    }

    const index = JSON.parse(await fs.promises.readFile(path.join(assetDirectory, 'indexes', `${assetId}.json`), { encoding: 'utf8' }))
    let counter = 0

    this.client.emit('progress', {
      type: 'assets',
      task: 0,
      total: Object.keys(index.objects).length
    })

    await pMap(Object.keys(index.objects), 50, async (/** @type {string} */ asset) => {
      if (this.client && this.client.aborted) throw new Error("Launch aborted by user");
      const assetObj = index.objects[asset]
      const hash = assetObj.hash
      const expectedSize = assetObj.size
      const subhash = hash.substring(0, 2)
      const subAsset = path.join(assetDirectory, 'objects', subhash)
      const assetFile = path.join(subAsset, hash)

      if (!(await this.verifyFileFast(assetFile, expectedSize, hash))) {
        await this.downloadAsync(`${this.options.overrides.url.resource}/${subhash}/${hash}`, subAsset, hash, true, 'assets')
        if (!(await this.checkSum(hash, assetFile))) {
          await this.downloadAsync(`${this.options.overrides.url.resource}/${subhash}/${hash}`, subAsset, hash, true, 'assets')
        }
      }
      counter++
      this.client.emit('progress', {
        type: 'assets',
        task: counter,
        total: Object.keys(index.objects).length
      })
    })


    if (this.isLegacy()) { counter = 0;
      if (fs.existsSync(path.join(assetDirectory, 'legacy'))) {
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

      await pMap(Object.keys(index.objects), 50, async (/** @type {string} */ asset) => {
        if (this.client && this.client.aborted) throw new Error("Launch aborted by user");
        const hash = index.objects[asset].hash
        const subhash = hash.substring(0, 2)
        const subAsset = path.join(assetDirectory, 'objects', subhash)

        const legacyAsset = asset.split('/')
        legacyAsset.pop()

        if (!(fs.existsSync(path.join(legacyDirectory, legacyAsset.join('/'))))) {
          await fs.promises.mkdir(path.join(legacyDirectory, legacyAsset.join('/')), { recursive: true })
        }

        if (!(fs.existsSync(path.join(legacyDirectory, asset)))) {
          await fs.promises.copyFile(path.join(subAsset, hash), path.join(legacyDirectory, asset))
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
    if (!versionStr) return { major: 0, minor: 0, patch: 0 };
    const str = String(versionStr);
    const mcMatch = str.match(/1\.(\d+)(?:\.(\d+))?/);
    if (mcMatch) {
      return {
        major: 1,
        minor: parseInt(mcMatch[1], 10) || 0,
        patch: parseInt(mcMatch[2], 10) || 0
      };
    }
    const modernMatch = str.match(/(?:^|[^\d])(\d+)\.(\d+)(?:\.(\d+))?/);
    if (modernMatch) {
      return {
        major: parseInt(modernMatch[1], 10) || 0,
        minor: parseInt(modernMatch[2], 10) || 0,
        patch: parseInt(modernMatch[3], 10) || 0
      };
    }
    const parts = str.split('.');
    if (parts[0] === '1') {
      return {
        major: 1,
        minor: parseInt(parts[1], 10) || 0,
        patch: parseInt(parts[2], 10) || 0
      };
    }
    return {
      major: parseInt(parts[0], 10) || 0,
      minor: parseInt(parts[1], 10) || 0,
      patch: parseInt(parts[2], 10) || 0
    };
  }

  /**
   * @param {any} v1
   * @param {any} v2
   * @returns {number}
   */
  compareVersion(v1, v2) {
    const a = typeof v1 === 'string' ? this.parseVersion(v1) : v1;
    const b = typeof v2 === 'string' ? this.parseVersion(v2) : v2;
    if (a.major !== b.major) return a.major - b.major;
    if (a.minor !== b.minor) return a.minor - b.minor;
    return a.patch - b.patch;
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
    if (lib.name) {
      const isArm64 = process.arch === 'arm64';
      const isX86 = process.arch === 'ia32';

      if (lib.name.includes('-arm64') && !isArm64) return true;
      if (lib.name.includes('-arm32') && process.arch !== 'arm') return true;
      if ((lib.name.endsWith('-x86') || lib.name.includes('-x86:')) && !isX86) return true;
    }

    if (lib.rules && lib.rules.length > 0) {
      const currentOS = this.getOS();
      const currentArch = process.arch === 'x64' ? 'x86_64' : (process.arch === 'ia32' ? 'x86' : process.arch);
      let allowed = !lib.rules.some((/** @type {any} */ r) => r && r.action === 'allow');
      for (const rule of lib.rules) {
        if (!rule) continue;
        let matches = true;
        if (rule.os) {
          if (rule.os.name && rule.os.name !== currentOS) matches = false;
          if (matches && rule.os.arch) {
            try {
              matches = new RegExp(rule.os.arch).test(currentArch);
            } catch (_) {
              matches = (rule.os.arch === currentArch);
            }
          }
        }
        if (matches) allowed = (rule.action === 'allow');
      }
      return !allowed;
    }
    return false;
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
    if (fs.existsSync(stampFile)) {
      hasNatives = true;
    }
    if (!hasNatives) {
      await fs.promises.mkdir(nativeDirectory, { recursive: true })

      const natives = async () => {
        /** @type {any[]} */
        const natives = []
        await pMap(this.version.libraries, 50, async (/** @type {any} */ lib) => {
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

      this.client.emit('progress', {
        type: 'natives',
        task: 0,
        total: stat.length
      })

      await pMap(stat, 50, async (/** @type {any} */ native) => {
        if (this.client && this.client.aborted) throw new Error("Launch aborted by user");
        if (!native) return
        const name = native.path.split('/').pop()
        if (!(fs.existsSync(path.join(nativeDirectory, name))) || !await this.checkSum(native.sha1, path.join(nativeDirectory, name))) {
          await this.downloadAsync(native.url, nativeDirectory, name, true, 'natives')
        }
        try {
          await new Zip(path.join(nativeDirectory, name)).extractAllTo(nativeDirectory, true)
        } catch (e) {
          console.warn(e)
        }
        if (fs.existsSync(path.join(nativeDirectory, name))) await fs.promises.unlink(path.join(nativeDirectory, name))
        counter++
        this.client.emit('progress', {
          type: 'natives',
          task: counter,
          total: stat.length
        })
      })
      await fs.promises.writeFile(stampFile, Date.now().toString(), 'utf8');
      this.client.emit('debug', '[Gens-Core]: Downloaded and extracted natives')
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
    let json = null
    let installerJson = null
    const versionPath = path.join(this.options.root, 'forge', `${this.version.id}`, 'version.json')
    if (fs.existsSync(versionPath)) {
      try {
        json = JSON.parse(await fs.promises.readFile(versionPath, 'utf8'))
        if (!json.forgeWrapperVersion || !(json.forgeWrapperVersion === this.options.overrides.fw.version)) {
          this.client.emit('debug', '[Gens-Core]: Old ForgeWrapper has generated this version JSON, re-generating')
        } else {
          if (this.isModernForge(json)) {
            this.fwAddArgs()
            this.options.forge = null
          }
          return json
        }
      } catch (e) {
        console.warn(e)
        this.client.emit('debug', '[Gens-Core]: Failed to parse Forge version JSON, re-generating')
      }
    }

    this.client.emit('debug', '[Gens-Core]: Generating Forge version json, this might take a bit')
    const zipFile = new Zip(this.options.forge)
    json = await zipFile.readAsText('version.json')
    if (zipFile.getEntry('install_profile.json')) installerJson = await zipFile.readAsText('install_profile.json')

    try {
      json = JSON.parse(json || '{}')
      if (installerJson) installerJson = JSON.parse(installerJson)
    } catch (e) {
      this.client.emit('debug', '[Gens-Core]: Failed to load json files for ForgeWrapper, using Vanilla instead')
      return null
    }
    if (installerJson) {
      json.mavenFiles
        ? json.mavenFiles = json.mavenFiles.concat(installerJson.libraries)
        : json.mavenFiles = installerJson.libraries
    }

    let jarEnding = 'universal'
    if (this.isModernForge(json)) {
      if (json.inheritsFrom !== '1.12.2') {
        this.fwAddArgs()
        const fwName = `ForgeWrapper-${this.options.overrides.fw.version}.jar`
        const fwPathArr = ['io', 'github', 'zekerzhayard', 'ForgeWrapper', this.options.overrides.fw.version]
        json.libraries.push({
          name: fwPathArr.join(':'),
          downloads: {
            artifact: {
              path: [...fwPathArr, fwName].join('/'),
              url: `${this.options.overrides.fw.baseUrl}${this.options.overrides.fw.version}/${fwName}`,
              sha1: this.options.overrides.fw.sh1,
              size: this.options.overrides.fw.size
            }
          }
        })
        json.mainClass = 'io.github.zekerzhayard.forgewrapper.installer.Main'
        jarEnding = 'launcher'

        for (const library of (json.mavenFiles || [])) {
          const lib = library.name.split(':')
          if (lib[0] === 'net.minecraftforge' && lib[1].includes('forge')) {
            library.downloads.artifact.url = this.options.overrides.url.mavenForge + library.downloads.artifact.path
            break
          }
        }
      } else {
        if (json.mavenFiles) {
          for (const library in json.mavenFiles) {
            const lib = json.mavenFiles[library]?.name?.split(':');
            if (lib && lib[0] === 'net.minecraftforge' && lib[1].includes('forge')) {
              delete json.mavenFiles[library];
              break;
            }
          }
        }
      }
    } else {
      await pMap(json.libraries || [], 50, async (/** @type {any} */ library) => {
        if (this.client && this.client.aborted) throw new Error("Launch aborted by user");
        const lib = library.name.split(':')
        if (lib[0] === 'net.minecraftforge' && lib[1].includes('forge')) return

        let url = this.options.overrides.url.mavenForge
        const name = `${lib[1]}-${lib[2]}.jar`

        if (!library.url) {
          if (library.serverreq || library.clientreq) {
            url = this.options.overrides.url.defaultRepoForge
          } else {
            return
          }
        }
        library.url = url
        const downloadLink = `${url}${lib[0].replace(/\./g, '/')}/${lib[1]}/${lib[2]}/${name}`
        await this.baseRequest(downloadLink, (error, response, body) => {
          if (error) {
            this.client.emit('debug', `[Gens-Core]: Failed checking request for ${downloadLink}`)
          } else {
            if (response.statusCode === 404) library.url = this.options.overrides.url.fallbackMaven
          }
        })
      })
    }
    if (json.libraries && json.libraries[0] && json.libraries[0].downloads) {
      const name = json.libraries[0].name
      if (name.includes('minecraftforge:forge') && !name.includes('universal')) {
        json.libraries[0].name = name + `:${jarEnding}`
        json.libraries[0].downloads.artifact.path = json.libraries[0].downloads.artifact.path.replace('.jar', `-${jarEnding}.jar`)
        json.libraries[0].downloads.artifact.url = this.options.overrides.url.mavenForge + json.libraries[0].downloads.artifact.path
      }
    } else if (json.libraries && json.libraries[0]) {
      delete json.libraries[0]
    }

    json.libraries = this.cleanUp(json.libraries)
    if (json.mavenFiles) json.mavenFiles = this.cleanUp(json.mavenFiles)

    json.forgeWrapperVersion = this.options.overrides.fw.version

    if (!(fs.existsSync(path.join(this.options.root, 'forge', this.version.id)))) {
      await fs.promises.mkdir(path.join(this.options.root, 'forge', this.version.id), { recursive: true })
    }
    await fs.promises.writeFile(versionPath, JSON.stringify(json, null, 4))

    if (this.isModernForge(json)) this.options.forge = null

    return json
  }

  /**
   * @param {string} directory
   * @param {any[]} libraries
   * @param {string} eventName
   * @returns {Promise<string[]>}
   */
  async downloadToDirectory(directory, libraries, eventName) {
    /** @type {string[]} */
    const libs = []
    let counter = 0

    await pMap(libraries, 50, async (/** @type {any} */ library) => {
      if (this.client && this.client.aborted) throw new Error("Launch aborted by user");
      if (!library) return
      if (this.parseRule(library)) return
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
          await this.downloadAsync(url, jarPath, name, true, eventName)
        } else if (libItem.downloads && libItem.downloads.artifact && libItem.downloads.artifact.url) {
          await this.downloadAsync(libItem.downloads.artifact.url, jarPath, name, true, eventName)
        }
      }

      const libFile = path.join(jarPath, name)
      const artifact = library.downloads && library.downloads.artifact
      const expectedSize = artifact ? artifact.size : undefined
      const expectedSha1 = artifact ? artifact.sha1 : undefined

      if (!(await this.verifyFileFast(libFile, expectedSize, expectedSha1))) {
        await downloadLibrary(library)
        if (expectedSha1 && !(await this.checkSum(expectedSha1, libFile))) {
          await downloadLibrary(library)
        }
      }

      counter++
      this.client.emit('progress', {
        type: eventName,
        task: counter,
        total: libraries.length
      })
      libs.push(`${jarPath}${path.sep}${name}`)
    })


    return libs
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
      libs = await this.downloadToDirectory(libraryDirectory, classJson.libraries, 'classes-custom')
    }

    const parsed = this.version.libraries.filter((/** @type {any} */ lib) => {
      if (lib.downloads && lib.downloads.artifact && !this.parseRule(lib)) {
        /** @param {any} n */
        const getLibIdentity = (n) => { const p = String(n || '').split(':'); return `${p[0] || ''}:${p[1] || ''}:${p[3] || ''}`; };
        if (!classJson || !classJson.libraries.some((/** @type {any} */ l) => l && getLibIdentity(l.name) === getLibIdentity(lib.name))) {
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
    /** @type {Record<string, string | null>} */
    const types = {
      singleplayer: '--quickPlaySingleplayer',
      multiplayer: '--quickPlayMultiplayer',
      realms: '--quickPlayRealms',
      legacy: null
    }
    const { type, identifier, path: qpPath } = this.options.quickPlay
    const keys = Object.keys(types)
    if (!keys.includes(type)) {
      this.client.emit('debug', `[Gens-Core]: quickPlay type is not valid. Valid types are: ${keys.join(', ')}`)
      return null
    }
    const returnArgs = type === 'legacy'
      ? ['--server', identifier.split(':')[0], '--port', identifier.split(':')[1] || '25565']
      : [types[type] || '', identifier]
    if (qpPath) returnArgs.push('--quickPlayPath', qpPath)
    return returnArgs
  }

  /**
   * @param {any} [modification]
   * @returns {Promise<string[]>}
   */
  async getLaunchOptions(modification) {
    const type = Object.assign({}, this.version, modification)

    let args = type.minecraftArguments
      ? type.minecraftArguments.split(' ')
      : type.arguments.game
    const assetRoot = path.resolve(this.options.overrides.assetRoot || path.join(this.options.root, 'assets'))
    const assetPath = this.isLegacy()
      ? path.join(this.options.root, 'resources')
      : path.join(assetRoot)

    const minArgs = this.options.overrides.minArgs || (this.isLegacy() ? 5 : 11)
    if (args.length < minArgs) args = args.concat(this.version.minecraftArguments ? this.version.minecraftArguments.split(' ') : this.version.arguments.game)
    if (this.options.customLaunchArgs) args = args.concat(this.options.customLaunchArgs)

    this.options.authorization = await Promise.resolve(this.options.authorization)
    this.options.authorization.meta = this.options.authorization.meta ? this.options.authorization.meta : { type: 'mojang' }
    /** @type {Record<string, any>} */
    const fields = {
      '${auth_access_token}': this.options.authorization.access_token,
      '${auth_session}': this.options.authorization.access_token,
      '${auth_player_name}': this.options.authorization.name,
      '${auth_uuid}': this.options.authorization.uuid,
      '${auth_xuid}': this.options.authorization.meta.xuid || this.options.authorization.access_token,
      '${user_properties}': this.options.authorization.user_properties,
      '${user_type}': this.options.authorization.meta.type,
      '${version_name}': this.options.version.number || this.options.overrides.versionName,
      '${assets_index_name}': this.getAssetIndexName(),
      '${game_directory}': this.options.overrides.gameDirectory || this.options.root,
      '${assets_root}': assetPath,
      '${game_assets}': assetPath,
      '${version_type}': this.options.version.type,
      '${clientid}': this.options.authorization.meta.clientId || (this.options.authorization.client_token || this.options.authorization.access_token),
      '${resolution_width}': this.options.window ? this.options.window.width : 856,
      '${resolution_height}': this.options.window ? this.options.window.height : 482
    }

    if (this.options.authorization.meta.demo && (this.options.features ? !this.options.features.includes('is_demo_user') : true)) {
      args.push('--demo')
    }

    /**
     * @param {any} obj
     * @param {number} index
     */
    const replaceArg = (obj, index) => {
      if (Array.isArray(obj.value)) {
        for (const arg of obj.value) {
          args.push(arg)
        }
      } else {
        args.push(obj.value)
      }
      delete args[index]
    }

    for (let index = 0; index < args.length; index++) {
      if (typeof args[index] === 'object') {
        if (args[index].rules) {
          if (!this.options.features) continue
          const featureFlags = []
          for (const rule of args[index].rules) {
            featureFlags.push(...Object.keys(rule.features))
          }
          let hasAllRules = true
          for (const feature of this.options.features) {
            if (!featureFlags.includes(feature)) {
              hasAllRules = false
            }
          }
          if (hasAllRules) replaceArg(args[index], index)
        } else {
          replaceArg(args[index], index)
        }
      } else {
        if (Object.keys(fields).includes(args[index])) {
          args[index] = fields[args[index]]
        }
      }
    }
    if (this.options.window) {
      if (this.options.window.fullscreen) {
        args.push('--fullscreen')
      } else {
        if (this.options.window.width) args.push('--width', this.options.window.width)
        if (this.options.window.height) args.push('--height', this.options.window.height)
      }
    }
    if (this.options.server) this.client.emit('debug', '[Gens-Core]: server and port are deprecated launch flags. Use the quickPlay field.')
    if (this.options.quickPlay) args = args.concat(this.formatQuickPlay())
    if (this.options.proxy) {
      args.push(
        '--proxyHost',
        this.options.proxy.host,
        '--proxyPort',
        this.options.proxy.port || '8080',
        '--proxyUser',
        this.options.proxy.username,
        '--proxyPass',
        this.options.proxy.password
      )
    }
    args = args.filter((/** @type {any} */ value) => typeof value === 'string' || typeof value === 'number')
    this.client.emit('debug', '[Gens-Core]: Set launch options')
    return args
  }

  /**
   * @param {any} modifyJson
   * @param {string} nativePath
   * @returns {Promise<string[]>}
   */
  async getJVMArgs(modifyJson, nativePath) {
    /** @type {string[]} */
    const args = [];
    const libraryDirectory = path.resolve(this.options.overrides.libraryRoot || path.join(this.options.root, 'libraries'));
    const assetRoot = path.resolve(this.options.overrides.assetRoot || path.join(this.options.root, 'assets'));
    const classpathSep = this.getOS() === 'windows' ? ';' : ':';
    const versionName = (this.options.version && (this.options.version.custom || this.options.version.number)) || this.options.overrides.versionName || '';
    /** @type {Record<string, string>} */
    const fields = {
      '${natives_directory}': nativePath,
      '${launcher_name}': this.options.overrides.launcherBrand || 'Gens-Launcher',
      '${launcher_version}': this.options.overrides.launcherVersion || '1.0.0',
      '${classpath}': '',
      '${library_directory}': libraryDirectory,
      '${classpath_separator}': classpathSep,
      '${version_name}': versionName,
      '${game_directory}': this.options.overrides.gameDirectory || this.options.root,
      '${assets_root}': assetRoot,
      '${assets_index_name}': this.getAssetIndexName()
    };

    /** @param {any} rule */
    const checkRule = (rule) => {
      if (!rule) return true;
      if (rule.action === 'allow') {
        if (rule.os) {
          if (rule.os.name && rule.os.name !== this.getOS()) return false;
          if (rule.os.arch) {
            const arch = process.arch === 'x64' ? 'x86_64' : (process.arch === 'ia32' ? 'x86' : process.arch);
            if (rule.os.arch === 'x86' && arch !== 'x86') return false;
            if (rule.os.arch === 'x86_64' && arch !== 'x86_64') return false;
            if (rule.os.arch === 'arm64' && arch !== 'arm64') return false;
          }
        }
        return true;
      }
      if (rule.action === 'disallow') {
        if (rule.os && rule.os.name && rule.os.name === this.getOS()) return false;
        return true;
      }
      return true;
    };

    /** @param {any} entry */
    const processEntry = (entry) => {
      if (typeof entry === 'string') {
        if (entry === '-cp' || entry === '${classpath}') return;
        let val = entry;
        for (const [k, v] of Object.entries(fields)) {
          val = val.split(k).join(v);
        }
        if ((val.startsWith('-D') || val.startsWith('-XX:')) && args.includes(val)) return;
        args.push(val);
      } else if (typeof entry === 'object' && entry !== null) {
        if (entry.rules) {
          const allowed = entry.rules.every(checkRule);
          if (!allowed) return;
        }
        const values = Array.isArray(entry.value) ? entry.value : [entry.value];
        for (const val of values) {
          if (val) processEntry(val);
        }
      }
    };

    if (this.version.arguments && this.version.arguments.jvm) {
      for (const entry of this.version.arguments.jvm) {
        processEntry(entry);
      }
    }

    if (modifyJson && modifyJson.arguments && modifyJson.arguments.jvm) {
      for (const entry of modifyJson.arguments.jvm) {
        processEntry(entry);
      }
    }

    if (args.length > 0) {
      if (!args.some(a => a.startsWith('-Djava.library.path='))) {
        args.push(`-Djava.library.path=${nativePath}`);
      }
      if (this.isVersionAtLeast(26, 0) && !args.some(a => a.includes('StackShadowPages'))) {
        args.push('-XX:StackShadowPages=32');
      }
      return args;
    }

    // Fallback for legacy Minecraft (< 1.13) without arguments.jvm
    const legacyArgs = [
      '-XX:-UseAdaptiveSizePolicy',
      '-XX:-OmitStackTraceInFastThrow',
      '-Dfml.ignorePatchDiscrepancies=true',
      '-Dfml.ignoreInvalidMinecraftCertificates=true',
      `-Djava.library.path=${nativePath}`
    ];
    legacyArgs.push(await this.getJVM());
    return legacyArgs;
  }

  async getJVM() {
    /** @type {Record<string, string>} */
    const opts = {
      windows: '-XX:HeapDumpPath=MojangTricksIntelDriversForPerformance_javaw.exe_minecraft.exe.heapdump',
      osx: '-XstartOnFirstThread',
      linux: '-Xss1M'
    }
    return opts[this.getOS()] || '-Xss1M';
  }

  isLegacy() {
    return this.version.assets === 'legacy' || this.version.assets === 'pre-1.6'
  }

  getOS() {
    if (this.options.os) {
      return this.options.os
    } else {
      switch (process.platform) {
        case 'win32': return 'windows'
        case 'darwin': return 'osx'
        default: return 'linux'
      }
    }
  }

  getMemory() {
    if (!this.options.memory) {
      this.client.emit('debug', '[Gens-Core]: Memory not set! Setting 1GB as MAX!')
      this.options.memory = {
        min: 512,
        max: 1023
      }
    }
    if (!isNaN(this.options.memory.max) && !isNaN(this.options.memory.min)) {
      if (this.options.memory.max < this.options.memory.min) {
        this.client.emit('debug', '[Gens-Core]: MIN memory is higher then MAX! Resetting!')
        this.options.memory.max = 1023
        this.options.memory.min = 512
      }
      return [`${this.options.memory.max}M`, `${this.options.memory.min}M`]
    } else { return [`${this.options.memory.max}`, `${this.options.memory.min}`] }
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
      if (fs.existsSync(options.clientPackage)) await fs.promises.unlink(options.clientPackage)
    }

    return this.client.emit('package-extract', true)
  }
}

module.exports = Handler
