const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const child = require('child_process')
let counter = 0

const yauzl = require('yauzl-promise');
const { pipeline } = require('stream/promises');

class Zip {
  constructor(zipPath) {
    this.zipPath = zipPath;
  }
  
  async extractAllTo(dest, overwrite) {
    const zipfile = await yauzl.open(this.zipPath);
    try {
      for await (const entry of zipfile) {
        const destPath = path.join(dest, entry.filename);
        if (entry.filename.endsWith('/')) {
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
  
  getEntry(fileName) {
    return true;
  }
}
async function pMap(array, limit, asyncCallback) {
  const results = [];
  const executing = [];
  for (let i = 0; i < array.length; i++) {
    const p = Promise.resolve().then(() => asyncCallback(array[i], i, array));
    results.push(p);
    if (limit <= array.length) {
      const e = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= limit) {
        await Promise.race(executing);
      }
    }
  }
  return Promise.all(results);
}

class Handler {
  constructor(client) {
    this.client = client
    this.options = client.options

  }


  async fetchText(url) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.statusText);
      return await res.text();
    } catch (e) {
      throw e;
    }
  }

  checkJava(java) {
    return new Promise(resolve => {
      child.execFile(java, ['-version'], (error, stdout, stderr) => {
        if (error) {
          resolve({
            run: false,
            message: error
          })
        } else {
          this.client.emit('debug', `[Gens-Core]: Using Java version ${stderr.match(/"(.*?)"/).pop()} ${stderr.includes('64-Bit') ? '64-bit' : '32-Bit'}`)
          resolve({
            run: true
          })
        }
      })
    })
  }

  async downloadAsync(url, directory, name, retry, type) {
    if (this.client && this.client.aborted) throw new Error("Launch aborted by user");
    if (this.options.offline) return path.join(directory, name);
    if (!(await existsSafe(directory))) {
      await fs.promises.mkdir(directory, { recursive: true });
    }
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
      return false;
    }

    const totalBytes = parseInt(response.headers.get('content-length') || '0');
    let receivedBytes = 0;

    const dest = fs.createWriteStream(path.join(directory, name));
    const { Readable } = require('stream');
    const bodyStream = Readable.fromWeb(response.body);

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

    bodyStream.pipe(dest);

    return new Promise((resolve, reject) => {
      dest.once('finish', () => {
        this.client.emit('download', name);
        resolve({ failed: false, asset: null });
      });
      dest.on('error', async (e) => {
        if (await existsSafe(path.join(directory, name))) await fs.promises.unlink(path.join(directory, name));
        if (retry) return resolve(await this.downloadAsync(url, directory, name, false, type));
        resolve({ failed: true, asset: null });
      });
    });
  }

  checkSum(hash, file) {
    return new Promise((resolve) => {
      const hashStream = crypto.createHash('sha1');
      const fileStream = fs.createReadStream(file);

      fileStream.on('error', (err) => {
        this.client.emit('debug', `[Gens-Core]: Failed to check file hash due to ${err}`);
        resolve(false);
      });

      hashStream.on('finish', () => {
        const sum = hashStream.read().toString('hex');
        resolve(hash === sum);
      });

      fileStream.pipe(hashStream);
    });
  }

  getVersion() {
    return new Promise(async resolve => {
      const versionJsonPath = this.options.overrides.versionJson || path.join(this.options.directory, `${this.options.version.number}.json`);
      if (await existsSafe(versionJsonPath)) {
        this.version = JSON.parse(await fs.promises.readFile(versionJsonPath, 'utf8'));
        return resolve(this.version);
      }

      const manifest = `${this.options.overrides.url.meta}/mc/game/version_manifest.json`;
      const cache = this.options.cache ? `${this.options.cache}/json` : `${this.options.root}/cache/json`;

      try {
        if (!(await existsSafe(cache))) {
          await fs.promises.mkdir(cache, { recursive: true });
        }
        const manifestBody = await this.fetchText(manifest);
        await fs.promises.writeFile(path.join(cache, 'version_manifest.json'), manifestBody);
        const parsed = JSON.parse(manifestBody);
        const desiredVersion = Object.values(parsed.versions).find(version => version.id === this.options.version.number);
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
          if (await existsSafe(path.join(cache, `${this.options.version.number}.json`))) {
            this.version = JSON.parse(await fs.promises.readFile(path.join(cache, `${this.options.version.number}.json`), 'utf8'));
            return resolve(this.version);
          }
        } catch (err) { }
        return resolve(e);
      }
    })
  }

  async getJar() {
    const jarPath = path.join(this.options.directory, `${this.options.version.custom ? this.options.version.custom : this.options.version.number}.jar`);
    if (await existsSafe(jarPath) && await this.checkSum(this.version.downloads.client.sha1, jarPath)) {
      this.client.emit('debug', '[Gens-Core]: Using existing version jar');
    } else {
      await this.downloadAsync(this.version.downloads.client.url, this.options.directory, `${this.options.version.custom ? this.options.version.custom : this.options.version.number}.jar`, true, 'version-jar');
    }
    await fs.promises.writeFile(path.join(this.options.directory, `${this.options.version.number}.json`), JSON.stringify(this.version, null, 4));
    return this.client.emit('debug', '[Gens-Core]: Downloaded version jar and wrote version json');
  }

  async getAssets() {
    const assetDirectory = path.resolve(this.options.overrides.assetRoot || path.join(this.options.root, 'assets'))
    const assetId = this.options.version.custom || this.options.version.number
    if (!(await existsSafe(path.join(assetDirectory, 'indexes', `${assetId}.json`)))) {
      await this.downloadAsync(this.version.assetIndex.url, path.join(assetDirectory, 'indexes'), `${assetId}.json`, true, 'asset-json')
    }

    const index = JSON.parse(await fs.promises.readFile(path.join(assetDirectory, 'indexes', `${assetId}.json`), { encoding: 'utf8' }))

    this.client.emit('progress', {
      type: 'assets',
      task: 0,
      total: Object.keys(index.objects).length
    })

    await pMap(Object.keys(index.objects), 50, async asset => {
      if (this.client && this.client.aborted) throw new Error("Launch aborted by user");
      const hash = index.objects[asset].hash
      const subhash = hash.substring(0, 2)
      const subAsset = path.join(assetDirectory, 'objects', subhash)

      if (!(await existsSafe(path.join(subAsset, hash))) || !await this.checkSum(hash, path.join(subAsset, hash))) {
        await this.downloadAsync(`${this.options.overrides.url.resource}/${subhash}/${hash}`, subAsset, hash, true, 'assets')
      }
      counter++
      this.client.emit('progress', {
        type: 'assets',
        task: counter,
        total: Object.keys(index.objects).length
      })
    })
    counter = 0

    if (this.isLegacy()) {
      if (await existsSafe(path.join(assetDirectory, 'legacy'))) {
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

      await pMap(Object.keys(index.objects), 50, async asset => {
        if (this.client && this.client.aborted) throw new Error("Launch aborted by user");
        const hash = index.objects[asset].hash
        const subhash = hash.substring(0, 2)
        const subAsset = path.join(assetDirectory, 'objects', subhash)

        const legacyAsset = asset.split('/')
        legacyAsset.pop()

        if (!(await existsSafe(path.join(legacyDirectory, legacyAsset.join('/'))))) {
          await fs.promises.mkdir(path.join(legacyDirectory, legacyAsset.join('/')), { recursive: true })
        }

        if (!(await existsSafe(path.join(legacyDirectory, asset)))) {
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
    counter = 0

    this.client.emit('debug', '[Gens-Core]: Downloaded assets')
  }

  parseRule(lib) {
    if (lib.rules) {
      if (lib.rules.length > 1) {
        if (lib.rules[0].action === 'allow' && lib.rules[1].action === 'disallow' && lib.rules[1].os.name === 'osx') {
          return this.getOS() === 'osx'
        }
        return true
      } else {
        if (lib.rules[0].action === 'allow' && lib.rules[0].os) return lib.rules[0].os.name !== this.getOS()
      }
    } else {
      return false
    }
  }

  async getNatives() {
    const nativeDirectory = path.resolve(this.options.overrides.natives || path.join(this.options.root, 'natives', this.version.id))

    if (parseInt(this.version.id.split('.')[1]) >= 19) return this.options.overrides.cwd || this.options.root

    let hasNatives = false;
    if (await existsSafe(nativeDirectory)) {
      const files = await fs.promises.readdir(nativeDirectory);
      if (files.length > 0) hasNatives = true;
    }
    if (!hasNatives) {
      await fs.promises.mkdir(nativeDirectory, { recursive: true })

      const natives = async () => {
        const natives = []
        await pMap(this.version.libraries, 50, async (lib) => {
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

      this.client.emit('progress', {
        type: 'natives',
        task: 0,
        total: stat.length
      })

      await pMap(stat, 50, async (native) => {
        if (this.client && this.client.aborted) throw new Error("Launch aborted by user");
        if (!native) return
        const name = native.path.split('/').pop()
        if (!(await existsSafe(path.join(nativeDirectory, name))) || !await this.checkSum(native.sha1, path.join(nativeDirectory, name))) {
          await this.downloadAsync(native.url, nativeDirectory, name, true, 'natives')
        }
        try {
          await new Zip(path.join(nativeDirectory, name)).extractAllTo(nativeDirectory, true)
        } catch (e) {
          console.warn(e)
        }
        if (await existsSafe(path.join(nativeDirectory, name))) await fs.promises.unlink(path.join(nativeDirectory, name))
        counter++
        this.client.emit('progress', {
          type: 'natives',
          task: counter,
          total: stat.length
        })
      })
      this.client.emit('debug', '[Gens-Core]: Downloaded and extracted natives')
    }

    counter = 0
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

  isModernForge(json) {
    return json.inheritsFrom && json.inheritsFrom.split('.')[1] >= 12 && !(json.inheritsFrom === '1.12.2' && (json.id.split('.')[json.id.split('.').length - 1]) === '2847')
  }

  async getForgedWrapped() {
    let json = null
    let installerJson = null
    const versionPath = path.join(this.options.root, 'forge', `${this.version.id}`, 'version.json')
    if (await existsSafe(versionPath)) {
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
      json = JSON.parse(json)
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

        for (const library of json.mavenFiles) {
          const lib = library.name.split(':')
          if (lib[0] === 'net.minecraftforge' && lib[1].includes('forge')) {
            library.downloads.artifact.url = this.options.overrides.url.mavenForge + library.downloads.artifact.path
            break
          }
        }
      } else {
        for (const library in json.mavenFiles) {
          const lib = json.mavenFiles[library].name.split(':')
          if (lib[0] === 'net.minecraftforge' && lib[1].includes('forge')) {
            delete json.mavenFiles[library]
            break
          }
        }
      }
    } else {
      await pMap(json.libraries, 50, async library => {
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
        this.baseRequest(downloadLink, (error, response, body) => {
          if (error) {
            this.client.emit('debug', `[Gens-Core]: Failed checking request for ${downloadLink}`)
          } else {
            if (response.statusCode === 404) library.url = this.options.overrides.url.fallbackMaven
          }
        })
      })
    }
    if (json.libraries[0].downloads) {
      const name = json.libraries[0].name
      if (name.includes('minecraftforge:forge') && !name.includes('universal')) {
        json.libraries[0].name = name + `:${jarEnding}`
        json.libraries[0].downloads.artifact.path = json.libraries[0].downloads.artifact.path.replace('.jar', `-${jarEnding}.jar`)
        json.libraries[0].downloads.artifact.url = this.options.overrides.url.mavenForge + json.libraries[0].downloads.artifact.path
      }
    } else {
      delete json.libraries[0]
    }

    json.libraries = this.cleanUp(json.libraries)
    if (json.mavenFiles) json.mavenFiles = this.cleanUp(json.mavenFiles)

    json.forgeWrapperVersion = this.options.overrides.fw.version

    if (!(await existsSafe(path.join(this.options.root, 'forge', this.version.id)))) {
      await fs.promises.mkdir(path.join(this.options.root, 'forge', this.version.id), { recursive: true })
    }
    await fs.promises.writeFile(versionPath, JSON.stringify(json, null, 4))

    if (this.isModernForge(json)) this.options.forge = null

    return json
  }

  async downloadToDirectory(directory, libraries, eventName) {
    const libs = []

    await pMap(libraries, 50, async library => {
      if (this.client && this.client.aborted) throw new Error("Launch aborted by user");
      if (!library) return
      if (this.parseRule(library)) return
      const lib = library.name.split(':')

      let jarPath
      let name
      if (library.downloads && library.downloads.artifact && library.downloads.artifact.path) {
        name = library.downloads.artifact.path.split('/')[library.downloads.artifact.path.split('/').length - 1]
        jarPath = path.join(directory, this.popString(library.downloads.artifact.path))
      } else {
        name = `${lib[1]}-${lib[2]}${lib[3] ? '-' + lib[3] : ''}.jar`
        jarPath = path.join(directory, `${lib[0].replace(/\./g, '/')}/${lib[1]}/${lib[2]}`)
      }

      const downloadLibrary = async library => {
        if (library.url) {
          const url = `${library.url}${lib[0].replace(/\./g, '/')}/${lib[1]}/${lib[2]}/${name}`
          await this.downloadAsync(url, jarPath, name, true, eventName)
        } else if (library.downloads && library.downloads.artifact && library.downloads.artifact.url) {
          await this.downloadAsync(library.downloads.artifact.url, jarPath, name, true, eventName)
        }
      }

      if (!(await existsSafe(path.join(jarPath, name)))) await downloadLibrary(library)
      if (library.downloads && library.downloads.artifact) {
        if (!await this.checkSum(library.downloads.artifact.sha1, path.join(jarPath, name))) await downloadLibrary(library)
      }

      counter++
      this.client.emit('progress', {
        type: eventName,
        task: counter,
        total: libraries.length
      })
      libs.push(`${jarPath}${path.sep}${name}`)
    })
    counter = 0

    return libs
  }

  async getClasses(classJson) {
    let libs = []

    const libraryDirectory = path.resolve(this.options.overrides.libraryRoot || path.join(this.options.root, 'libraries'))

    if (classJson) {
      if (classJson.mavenFiles) {
        await this.downloadToDirectory(libraryDirectory, classJson.mavenFiles, 'classes-maven-custom')
      }
      libs = await this.downloadToDirectory(libraryDirectory, classJson.libraries, 'classes-custom')
    }

    const parsed = this.version.libraries.filter(lib => {
      if (lib.downloads && lib.downloads.artifact && !this.parseRule(lib)) {
        if (!classJson || !classJson.libraries.some(l => l.name.split(':')[1] === lib.name.split(':')[1])) {
          return true
        }
      }
      return false
    })

    libs = libs.concat((await this.downloadToDirectory(libraryDirectory, parsed, 'classes')))
    counter = 0

    this.client.emit('debug', '[Gens-Core]: Collected class paths')
    return libs
  }

  popString(path) {
    return path.split('/').slice(0, -1).join('/')
  }

  cleanUp(array) {
    return [...new Set(Object.values(array).filter(value => value !== null))]
  }

  formatQuickPlay() {
    const types = {
      singleplayer: '--quickPlaySingleplayer',
      multiplayer: '--quickPlayMultiplayer',
      realms: '--quickPlayRealms',
      legacy: null
    }
    const { type, identifier, path } = this.options.quickPlay
    const keys = Object.keys(types)
    if (!keys.includes(type)) {
      this.client.emit('debug', `[Gens-Core]: quickPlay type is not valid. Valid types are: ${keys.join(', ')}`)
      return null
    }
    const returnArgs = type === 'legacy'
      ? ['--server', identifier.split(':')[0], '--port', identifier.split(':')[1] || '25565']
      : [types[type], identifier]
    if (path) returnArgs.push('--quickPlayPath', path)
    return returnArgs
  }

  async getLaunchOptions(modification) {
    const type = Object.assign({}, this.version, modification)

    let args = type.minecraftArguments
      ? type.minecraftArguments.split(' ')
      : type.arguments.game
    const assetRoot = path.resolve(this.options.overrides.assetRoot || path.join(this.options.root, 'assets'))
    const assetPath = this.isLegacy()
      ? path.join(this.options.root, 'resources')
      : path.join(assetRoot)

    const minArgs = this.options.overrides.minArgs || this.isLegacy() ? 5 : 11
    if (args.length < minArgs) args = args.concat(this.version.minecraftArguments ? this.version.minecraftArguments.split(' ') : this.version.arguments.game)
    if (this.options.customLaunchArgs) args = args.concat(this.options.customLaunchArgs)

    this.options.authorization = await Promise.resolve(this.options.authorization)
    this.options.authorization.meta = this.options.authorization.meta ? this.options.authorization.meta : { type: 'mojang' }
    const fields = {
      '${auth_access_token}': this.options.authorization.access_token,
      '${auth_session}': this.options.authorization.access_token,
      '${auth_player_name}': this.options.authorization.name,
      '${auth_uuid}': this.options.authorization.uuid,
      '${auth_xuid}': this.options.authorization.meta.xuid || this.options.authorization.access_token,
      '${user_properties}': this.options.authorization.user_properties,
      '${user_type}': this.options.authorization.meta.type,
      '${version_name}': this.options.version.number || this.options.overrides.versionName,
      '${assets_index_name}': this.options.overrides.assetIndex || this.options.version.custom || this.options.version.number,
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
    args = args.filter(value => typeof value === 'string' || typeof value === 'number')
    this.client.emit('debug', '[Gens-Core]: Set launch options')
    return args
  }

  async getJVM() {
    const opts = {
      windows: '-XX:HeapDumpPath=MojangTricksIntelDriversForPerformance_javaw.exe_minecraft.exe.heapdump',
      osx: '-XstartOnFirstThread',
      linux: '-Xss1M'
    }
    return opts[this.getOS()]
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

  async extractPackage(options = this.options) {
    if (options.clientPackage.startsWith('http')) {
      await this.downloadAsync(options.clientPackage, options.root, 'clientPackage.zip', true, 'client-package')
      options.clientPackage = path.join(options.root, 'clientPackage.zip')
    }
    await new Zip(options.clientPackage).extractAllTo(options.root, true)
    if (options.removePackage) {
      if (await existsSafe(options.clientPackage)) await fs.promises.unlink(options.clientPackage)
    }

    return this.client.emit('package-extract', true)
  }
}

module.exports = Handler


async function existsSafe(p) {
    try {
        // Enforce preload sandbox check if it's in renderer context and enforceReadSandbox exists
        if (typeof enforceReadSandbox !== 'undefined') p = enforceReadSandbox(p, true);
        await fs.promises.access(p);
        return true;
    } catch {
        return false;
    }
}
