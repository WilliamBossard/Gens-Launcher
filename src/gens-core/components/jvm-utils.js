// @ts-check
const path = require('path');
const child = require('child_process');

/**
 * @param {string} versionStr
 * @returns {{ major: number; minor: number; patch: number }}
 */
function parseVersion(versionStr) {
  if (!versionStr) return { major: 0, minor: 0, patch: 0 };
  const str = String(versionStr);
  const snapMatch = str.match(/^(\d{2})w(\d{2})[a-z]$/i);
  if (snapMatch) {
    const year = parseInt(snapMatch[1], 10);
    if (year >= 26) {
      return { major: year, minor: 0, patch: 0 };
    }
    // 22w11a+ correspond à Minecraft 1.19+ ; les snapshots antérieurs (ex: 14w10a) sont < 1.19
    return { major: 1, minor: year >= 22 ? 19 : 0, patch: 0 };
  }
  const mcMatch = str.match(/(?:^|[^\d.])1\.(\d+)(?:\.(\d+))?/);
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
function compareVersion(v1, v2) {
  const a = typeof v1 === 'string' ? parseVersion(v1) : v1;
  const b = typeof v2 === 'string' ? parseVersion(v2) : v2;
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * @param {any} options
 * @returns {'windows' | 'osx' | 'linux' | string}
 */
function getOS(options) {
  if (options && options.os) {
    return options.os;
  }
  switch (process.platform) {
    case 'win32': return 'windows';
    case 'darwin': return 'osx';
    default: return 'linux';
  }
}

/**
 * @param {string} currentArch
 * @param {string} ruleArch
 * @returns {boolean}
 */
function matchArch(currentArch, ruleArch) {
  if (typeof ruleArch !== 'string' || !ruleArch) return false;
  if (ruleArch === currentArch) return true;
  if (!/^[a-zA-Z0-9_^$|()-]{1,32}$/.test(ruleArch)) {
    return false;
  }
  try {
    return new RegExp(ruleArch).test(currentArch);
  } catch (_) {
    return false;
  }
}

/**
 * Évalue les règles Mojang (allow/disallow, os, arch, features).
 * Retourne true si l'élément est autorisé.
 * @param {any[]} rules
 * @param {string} currentOS
 * @param {string[]} [features]
 * @returns {boolean}
 */
function evaluateMojangRules(rules, currentOS, features) {
  if (!Array.isArray(rules) || rules.length === 0) return true;
  const currentArch = process.arch === 'x64' ? 'x86_64' : (process.arch === 'ia32' ? 'x86' : process.arch);
  const enabledFeatures = new Set(Array.isArray(features) ? features : []);
  let allowed = !rules.some((/** @type {any} */ r) => r && r.action === 'allow');
  for (const rule of rules) {
    if (!rule) continue;
    let matches = true;
    if (rule.os) {
      if (rule.os.name && rule.os.name !== currentOS) matches = false;
      if (matches && rule.os.arch) {
        matches = matchArch(currentArch, rule.os.arch);
      }
    }
    if (matches && rule.features && typeof rule.features === 'object') {
      for (const [featKey, featVal] of Object.entries(rule.features)) {
        if (Boolean(featVal) !== enabledFeatures.has(featKey)) {
          matches = false;
          break;
        }
      }
    }
    if (matches) allowed = (rule.action === 'allow');
  }
  return allowed;
}

/**
 * Retourne true si la bibliothèque doit être IGNORÉE selon ses règles/classificateurs arch.
 * @param {any} lib
 * @param {string} currentOS
 * @returns {boolean}
 */
function parseRule(lib, currentOS) {
  if (lib.name) {
    const isArm64 = process.arch === 'arm64';
    const isX86 = process.arch === 'ia32';

    if (lib.name.includes('-arm64') && !isArm64) return true;
    if (lib.name.includes('-arm32') && process.arch !== 'arm') return true;
    if ((lib.name.endsWith('-x86') || lib.name.includes('-x86:') || lib.name.includes('-x86_64') || lib.name.includes('-amd64')) && !isX86 && !(lib.name.includes('-x86_64') && process.arch === 'x64') && !(lib.name.includes('-amd64') && process.arch === 'x64')) return true;
    if (isArm64 && /:natives-(?:linux|windows|macos|osx)(?:$|:)/.test(lib.name)) return true;
  }

  if (lib.rules && lib.rules.length > 0) {
    return !evaluateMojangRules(lib.rules, currentOS);
  }
  return false;
}

/**
 * @param {string} java
 * @param {any} client
 * @returns {Promise<{ run: boolean; message?: any }>}
 */
function checkJava(java, client) {
  return new Promise(resolve => {
    let javaConsole = java;
    if (typeof javaConsole === 'string' && process.platform === 'win32') {
      if (javaConsole.toLowerCase().endsWith('javaw.exe')) {
        javaConsole = javaConsole.slice(0, -9) + 'java.exe';
      } else if (javaConsole.toLowerCase().endsWith('javaw')) {
        javaConsole = javaConsole.slice(0, -5) + 'java';
      }
    }

    child.execFile(javaConsole, ['-version'], { timeout: 10000 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ run: false, message: error });
      } else {
        const verMatch = (stderr && stderr.match(/"(.*?)"/)) || (stdout && stdout.match(/"(.*?)"/));
        client?.emit('debug', `[Gens-Core]: Using Java version ${verMatch ? verMatch[1] : 'unknown'} ${stderr && stderr.includes('64-Bit') ? '64-bit' : '32-Bit'}`);
        resolve({ run: true });
      }
    });
  });
}

/**
 * @param {any} options
 * @param {any} client
 * @returns {string[] | null}
 */
function formatQuickPlay(options, client) {
  /** @type {Record<string, string | null>} */
  const types = {
    singleplayer: '--quickPlaySingleplayer',
    multiplayer: '--quickPlayMultiplayer',
    realms: '--quickPlayRealms',
    legacy: null
  };
  const { type, identifier, path: qpPath } = options.quickPlay;
  const keys = Object.keys(types);
  if (!keys.includes(type)) {
    client?.emit('debug', `[Gens-Core]: quickPlay type is not valid. Valid types are: ${keys.join(', ')}`);
    return null;
  }
  const returnArgs = type === 'legacy'
    ? ['--server', identifier.split(':')[0], '--port', identifier.split(':')[1] || '25565']
    : [types[type] || '', identifier];
  if (qpPath) returnArgs.push('--quickPlayPath', qpPath);
  return returnArgs;
}

/**
 * @param {string} osName
 * @returns {string}
 */
function getJVMDefaultArg(osName) {
  /** @type {Record<string, string>} */
  const opts = {
    windows: '-XX:HeapDumpPath=MojangTricksIntelDriversForPerformance_javaw.exe_minecraft.exe.heapdump',
    osx: '-XstartOnFirstThread',
    linux: '-Xss1M'
  };
  return opts[osName] || '-Xss1M';
}

/**
 * @param {any} options
 * @param {any} client
 * @returns {string[]}
 */
function getMemory(options, client) {
  if (!options.memory) {
    client?.emit('debug', '[Gens-Core]: Memory not set! Setting 1GB as MAX!');
    options.memory = { min: 512, max: 1023 };
  }
  if (!isNaN(options.memory.max) && !isNaN(options.memory.min)) {
    if (options.memory.max < options.memory.min) {
      client?.emit('debug', '[Gens-Core]: MIN memory is higher then MAX! Resetting!');
      options.memory.max = 1023;
      options.memory.min = 512;
    }
    return [`${options.memory.max}M`, `${options.memory.min}M`];
  }
  return [`${options.memory.max}`, `${options.memory.min}`];
}

/**
 * @param {{
 *   version: any;
 *   options: any;
 *   client: any;
 *   isLegacy: boolean;
 *   assetIndexName: string;
 *   quickPlayArgs: string[] | null;
 *   modification?: any;
 * }} ctx
 * @returns {Promise<string[]>}
 */
async function buildLaunchOptions(ctx) {
  const { version, options, client, isLegacy, assetIndexName, quickPlayArgs, modification } = ctx;
  const type = Object.assign({}, version, modification);
  const currentOS = getOS(options);

  let args = type.minecraftArguments
    ? type.minecraftArguments.split(' ')
    : [...(type.arguments?.game || [])];
  const assetRoot = path.resolve(options.overrides.assetRoot || path.join(options.root, 'assets'));
  const assetPath = isLegacy
    ? path.join(options.root, 'resources')
    : path.join(assetRoot);

  if (modification && !type.minecraftArguments && modification.arguments?.game && version.arguments?.game) {
    args = [...version.arguments.game, ...modification.arguments.game];
  } else {
    const minArgs = options.overrides.minArgs || (isLegacy ? 5 : 11);
    if (args.length < minArgs) {
      args = args.concat(version.minecraftArguments ? version.minecraftArguments.split(' ') : (version.arguments?.game || []));
    }
  }
  if (options.customLaunchArgs) args = args.concat(options.customLaunchArgs);

  options.authorization = await Promise.resolve(options.authorization);
  options.authorization.meta = options.authorization.meta ? options.authorization.meta : { type: 'mojang' };
  /** @type {Record<string, any>} */
  const fields = {
    '${auth_access_token}': options.authorization.access_token,
    '${auth_session}': options.authorization.access_token,
    '${auth_player_name}': options.authorization.name,
    '${auth_uuid}': options.authorization.uuid,
    '${auth_xuid}': options.authorization.meta.xuid || '0',
    '${user_properties}': options.authorization.user_properties,
    '${user_type}': options.authorization.meta.type,
    '${version_name}': options.version.number || options.overrides.versionName,
    '${assets_index_name}': assetIndexName,
    '${game_directory}': options.overrides.gameDirectory || options.root,
    '${assets_root}': assetPath,
    '${game_assets}': assetPath,
    '${version_type}': options.version.type,
    '${clientid}': options.authorization.meta.clientId || options.authorization.client_token || '',
    '${resolution_width}': options.window ? options.window.width : 856,
    '${resolution_height}': options.window ? options.window.height : 482
  };

  if (options.authorization.meta.demo && (options.features ? !options.features.includes('is_demo_user') : true)) {
    args.push('--demo');
  }

  /** @type {any[]} */
  const resolvedArgs = [];
  for (const entry of args) {
    if (entry && typeof entry === 'object') {
      if (entry.rules && !evaluateMojangRules(entry.rules, currentOS, options.features)) {
        continue;
      }
      const vals = Array.isArray(entry.value) ? entry.value : [entry.value];
      for (const v of vals) {
        if (v !== undefined && v !== null) resolvedArgs.push(v);
      }
    } else if (entry !== undefined && entry !== null) {
      resolvedArgs.push(entry);
    }
  }
  args = resolvedArgs.map((arg) => (typeof arg === 'string' && Object.prototype.hasOwnProperty.call(fields, arg)) ? fields[arg] : arg);
  if (options.window) {
    if (options.window.fullscreen) {
      args.push('--fullscreen');
    } else {
      if (options.window.width) args.push('--width', options.window.width);
      if (options.window.height) args.push('--height', options.window.height);
    }
  }
  if (options.quickPlay && quickPlayArgs) {
    args = args.concat(quickPlayArgs);
  } else if (options.server && options.server.host) {
    // Support legacy Minecraft < 1.20 (--server / --port)
    args.push('--server', String(options.server.host));
    if (options.server.port) {
      args.push('--port', String(options.server.port));
    }
  }
  if (options.proxy) {
    args.push(
      '--proxyHost',
      options.proxy.host,
      '--proxyPort',
      options.proxy.port || '8080',
      '--proxyUser',
      options.proxy.username,
      '--proxyPass',
      options.proxy.password
    );
  }
  args = args.filter((/** @type {any} */ value) => typeof value === 'string' || typeof value === 'number');
  client?.emit('debug', '[Gens-Core]: Set launch options');
  return args;
}

/**
 * @param {{
 *   version: any;
 *   options: any;
 *   modifyJson: any;
 *   nativePath: string;
 *   isAtLeast26: boolean;
 *   legacyJvmArg: string;
 *   assetIndexName: string;
 *   features?: string[];
 * }} ctx
 * @returns {string[]}
 */
function buildJVMArgs(ctx) {
  const { version, options, modifyJson, nativePath, isAtLeast26, legacyJvmArg, assetIndexName, features } = ctx;
  /** @type {string[]} */
  const args = [];
  const currentOS = getOS(options);
  const libraryDirectory = path.resolve(options.overrides.libraryRoot || path.join(options.root, 'libraries'));
  const assetRoot = path.resolve(options.overrides.assetRoot || path.join(options.root, 'assets'));
  const classpathSep = currentOS === 'windows' ? ';' : ':';
  const versionName = (options.version && (options.version.custom || options.version.number)) || options.overrides.versionName || '';
  /** @type {Record<string, string>} */
  const fields = {
    '${natives_directory}': nativePath,
    '${launcher_name}': options.overrides.launcherBrand || 'Gens-Launcher',
    '${launcher_version}': options.overrides.launcherVersion || '1.0.0',
    '${classpath}': '',
    '${library_directory}': libraryDirectory,
    '${classpath_separator}': classpathSep,
    '${version_name}': versionName,
    '${game_directory}': options.overrides.gameDirectory || options.root,
    '${assets_root}': assetRoot,
    '${assets_index_name}': assetIndexName
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
      if (entry.rules && !evaluateMojangRules(entry.rules, currentOS, features)) return;
      const values = Array.isArray(entry.value) ? entry.value : [entry.value];
      for (const val of values) {
        if (val) processEntry(val);
      }
    }
  };

  if (version.arguments && version.arguments.jvm) {
    for (const entry of version.arguments.jvm) processEntry(entry);
  }
  if (modifyJson && modifyJson.arguments && modifyJson.arguments.jvm) {
    for (const entry of modifyJson.arguments.jvm) processEntry(entry);
  }

  if (args.length > 0) {
    if (!args.some(a => a.startsWith('-Djava.library.path='))) {
      args.push(`-Djava.library.path=${nativePath}`);
    }
    if (isAtLeast26 && !args.some(a => a.includes('StackShadowPages'))) {
      args.push('-XX:StackShadowPages=32');
    }
    return args;
  }

  return [
    '-XX:-UseAdaptiveSizePolicy',
    '-XX:-OmitStackTraceInFastThrow',
    '-Dfml.ignorePatchDiscrepancies=true',
    '-Dfml.ignoreInvalidMinecraftCertificates=true',
    `-Djava.library.path=${nativePath}`,
    legacyJvmArg
  ];
}

module.exports = {
  parseVersion,
  compareVersion,
  getOS,
  evaluateMojangRules,
  parseRule,
  checkJava,
  formatQuickPlay,
  getJVMDefaultArg,
  getMemory,
  buildLaunchOptions,
  buildJVMArgs
};
