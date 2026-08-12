const child = require('child_process')
const path = require('path')
const Handler = require('./handler')
const fs = require('fs')
const EventEmitter = require('events').EventEmitter

class MCLCore extends EventEmitter {
  async launch(options) {
    try {
      this.options = { ...options }
      this.options.root = path.resolve(this.options.root)
      this.options.overrides = {
        detached: true,
        ...this.options.overrides,
        url: {
          meta: 'https://launchermeta.mojang.com',
          resource: 'https://resources.download.minecraft.net',
          mavenForge: 'https://files.minecraftforge.net/maven/',
          defaultRepoForge: 'https://libraries.minecraft.net/',
          fallbackMaven: 'https://search.maven.org/remotecontent?filepath=',
          ...this.options.overrides
            ? this.options.overrides.url
            : undefined
        },
        fw: {
          baseUrl: 'https://github.com/ZekerZhayard/ForgeWrapper/releases/download/',
          version: '1.6.0',
          sh1: '035a51fe6439792a61507630d89382f621da0f1f',
          size: 28679,
          ...this.options.overrides
            ? this.options.overrides.fw
            : undefined
        }
      }

      this.handler = new Handler(this)

      await this.printVersion()

      const java = await this.handler.checkJava(this.options.javaPath || 'java')
      if (!java.run) {
        this.emit('debug', `[Gens-Core]: Couldn't start Minecraft due to: ${java.message}`)
        this.emit('close', 1)
        return null
      }

      await this.createRootDirectory()
      await this.createGameDirectory()

      await this.extractPackage()

      const directory = this.options.overrides.directory || path.join(this.options.root, 'versions', this.options.version.custom ? this.options.version.custom : this.options.version.number)
      this.options.directory = directory

      const versionFile = await this.handler.getVersion()
      const mcPath = this.options.overrides.minecraftJar || (this.options.version.custom
        ? path.join(this.options.root, 'versions', this.options.version.custom, `${this.options.version.custom}.jar`)
        : path.join(directory, `${this.options.version.number}.jar`))
      this.options.mcPath = mcPath
      const nativePath = await this.handler.getNatives()

      if (!(await window.existsSafe(mcPath)) && !this.options.offline) {
        this.emit('debug', '[Gens-Core]: Attempting to download Minecraft version jar')
        await this.handler.getJar()
      }

      const modifyJson = await this.getModifyJson()

      const args = []

      let jvm = [
        '-XX:-UseAdaptiveSizePolicy',
        '-XX:-OmitStackTraceInFastThrow',
        '-Dfml.ignorePatchDiscrepancies=true',
        '-Dfml.ignoreInvalidMinecraftCertificates=true',
        `-Djava.library.path=${nativePath}`,
        `-Xmx${this.handler.getMemory()[0]}`,
        `-Xms${this.handler.getMemory()[1]}`
      ]
      if (this.handler.getOS() === 'osx') {
        if (parseInt(versionFile.id.split('.')[1]) > 12) jvm.push(await this.handler.getJVM())
      } else jvm.push(await this.handler.getJVM())

      if (this.options.customArgs) jvm = jvm.concat(this.options.customArgs)
      if (this.options.overrides.logj4ConfigurationFile) {
        jvm.push(`-Dlog4j.configurationFile=${path.resolve(this.options.overrides.logj4ConfigurationFile)}`)
      }
      // https://help.minecraft.net/hc/en-us/articles/4416199399693-Security-Vulnerability-in-Minecraft-Java-Edition
      if (parseInt(versionFile.id.split('.')[1]) === 18 && !parseInt(versionFile.id.split('.')[2])) jvm.push('-Dlog4j2.formatMsgNoLookups=true')
      if (parseInt(versionFile.id.split('.')[1]) === 17) jvm.push('-Dlog4j2.formatMsgNoLookups=true')
      if (parseInt(versionFile.id.split('.')[1]) < 17) {
        if (!jvm.find(arg => arg.includes('Dlog4j.configurationFile'))) {
          const configPath = path.resolve(this.options.overrides.cwd || this.options.root)
          const intVersion = parseInt(versionFile.id.split('.')[1])
          if (intVersion >= 12) {
            await this.handler.downloadAsync('https://launcher.mojang.com/v1/objects/02937d122c86ce73319ef9975b58896fc1b491d1/log4j2_112-116.xml',
              configPath, 'log4j2_112-116.xml', true, 'log4j')
            jvm.push('-Dlog4j.configurationFile=log4j2_112-116.xml')
          } else if (intVersion >= 7) {
            await this.handler.downloadAsync('https://launcher.mojang.com/v1/objects/dd2b723346a8dcd48e7f4d245f6bf09e98db9696/log4j2_17-111.xml',
              configPath, 'log4j2_17-111.xml', true, 'log4j')
            jvm.push('-Dlog4j.configurationFile=log4j2_17-111.xml')
          }
        }
      }

      const classes = this.options.overrides.classes || this.handler.cleanUp(await this.handler.getClasses(modifyJson))
      const classPaths = ['-cp']
      const separator = this.handler.getOS() === 'windows' ? ';' : ':'
      this.emit('debug', `[Gens-Core]: Using ${separator} to separate class paths`)
      const file = modifyJson || versionFile
      const jar = await window.existsSafe(mcPath)
        ? `${separator}${mcPath}`
        : `${separator}${path.join(directory, `${this.options.version.number}.jar`)}`
      classPaths.push(`${this.options.forge ? this.options.forge + separator : ''}${classes.join(separator)}${jar}`)
      classPaths.push(file.mainClass)

      if (!this.options.offline) {
        this.emit('debug', '[Gens-Core]: Attempting to download assets')
        await this.handler.getAssets()
      }

      const launchOptions = await this.handler.getLaunchOptions(modifyJson)
      if (this.aborted) throw new Error("Launch aborted by user")

      const launchArguments = args.concat(jvm, classPaths, launchOptions)
      this.emit('arguments', launchArguments)
      this.emit('debug', `[Gens-Core]: Launching with arguments ${launchArguments.join(' ')}`)

      return this.startMinecraft(launchArguments)
    } catch (e) {
      this.emit('debug', `[Gens-Core]: Failed to start due to ${e}, closing...`)
      return null
    }
  }

  abort() {
    this.aborted = true
  }

  async printVersion() {
    if (await window.existsSafe(path.join(__dirname, '..', 'package.json'))) {
      const { version } = require('../package.json')
      this.emit('debug', `[Gens-Core]: MCLC version ${version}`)
    } else { this.emit('debug', '[Gens-Core]: Package JSON not found, skipping MCLC version check.') }
  }

  async createRootDirectory() {
    if (!(await window.existsSafe(this.options.root))) {
      this.emit('debug', '[Gens-Core]: Attempting to create root folder')
      await fs.promises.mkdir(this.options.root, { recursive: true })
    }
  }

  async createGameDirectory() {
    if (this.options.overrides.gameDirectory) {
      this.options.overrides.gameDirectory = path.resolve(this.options.overrides.gameDirectory)
      if (!(await window.existsSafe(this.options.overrides.gameDirectory))) {
        await fs.promises.mkdir(this.options.overrides.gameDirectory, { recursive: true })
      }
    }
  }

  async extractPackage() {
    if (this.options.clientPackage) {
      this.emit('debug', `[Gens-Core]: Extracting client package to ${this.options.root}`)
      await this.handler.extractPackage()
    }
  }

  async getModifyJson() {
    let modifyJson = null

    if (this.options.forge) {
      this.options.forge = path.resolve(this.options.forge)
      this.emit('debug', '[Gens-Core]: Detected Forge in options, getting dependencies')
      modifyJson = await this.handler.getForgedWrapped()
    } else if (this.options.version.custom) {
      this.emit('debug', '[Gens-Core]: Detected custom in options, setting custom version file')
      modifyJson = modifyJson || JSON.parse(await fs.promises.readFile(path.join(this.options.root, 'versions', this.options.version.custom, `${this.options.version.custom}.json`), { encoding: 'utf8' }))
    }

    return modifyJson
  }

  startMinecraft(launchArguments) {
    const isDetached = this.options.overrides.detached !== false;
    const minecraft = child.spawn(this.options.javaPath ? this.options.javaPath : 'java', launchArguments,
      { cwd: this.options.overrides.cwd || this.options.root, detached: isDetached })
    minecraft.stdout.on('data', (data) => this.emit('data', data.toString('utf-8')))
    minecraft.stderr.on('data', (data) => this.emit('data', data.toString('utf-8')))
    minecraft.on('close', (code) => this.emit('close', code))
    if (isDetached) minecraft.unref();
    return minecraft
  }
}

module.exports = MCLCore
