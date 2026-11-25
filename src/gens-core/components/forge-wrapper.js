// @ts-check
const fs = require('fs');
const path = require('path');
const { Zip, existsAsync } = require('./zip-archive');
const { pMap, writeFileAtomic } = require('./network-utils');

/**
 * Résout ou génère le version.json Forge / NeoForge (ForgeWrapper pour versions modernes).
 * @param {any} handler
 * @returns {Promise<any>}
 */
async function resolveForgedWrapped(handler) {
  let json = null;
  let installerJson = null;
  const versionPath = path.join(handler.options.root, 'forge', `${handler.version.id}`, 'version.json');
  if (await existsAsync(versionPath)) {
    try {
      json = JSON.parse(await fs.promises.readFile(versionPath, 'utf8'));
      if (!json.forgeWrapperVersion || !(json.forgeWrapperVersion === handler.options.overrides.fw.version)) {
        handler.client.emit('debug', '[Gens-Core]: Old ForgeWrapper has generated this version JSON, re-generating');
      } else {
        if (handler.isModernForge(json)) {
          handler.fwAddArgs();
          handler.options.forge = null;
        }
        return json;
      }
    } catch (e) {
      console.warn(e);
      handler.client.emit('debug', '[Gens-Core]: Failed to parse Forge version JSON, re-generating');
    }
  }

  handler.client.emit('debug', '[Gens-Core]: Generating Forge version json, this might take a bit');
  const zipFile = new Zip(handler.options.forge);
  let forgeTexts;
  try {
    forgeTexts = await zipFile.readEntriesAsText(['version.json', 'install_profile.json'], { throwOnError: true });
  } catch (zipErr) {
    const errMsg = zipErr instanceof Error ? zipErr.message : String(zipErr);
    handler.client.emit('debug', `[Gens-Core]: Corrupt or unreadable Forge archive (${errMsg})`);
    throw new Error(`Archive Forge corrompue ou illisible : ${errMsg}`);
  }
  json = forgeTexts['version.json'] ?? null;
  if (forgeTexts['install_profile.json'] !== undefined) installerJson = forgeTexts['install_profile.json'];

  try {
    json = JSON.parse(json || '{}');
    if (installerJson) installerJson = JSON.parse(installerJson);
  } catch (_) {
    handler.client.emit('debug', '[Gens-Core]: Failed to load json files for ForgeWrapper, using Vanilla instead');
    return null;
  }
  if (installerJson) {
    json.mavenFiles
      ? json.mavenFiles = json.mavenFiles.concat(installerJson.libraries)
      : json.mavenFiles = installerJson.libraries;
  }

  let jarEnding = 'universal';
  if (handler.isModernForge(json)) {
    if (json.inheritsFrom !== '1.12.2') {
      handler.fwAddArgs();
      const fwName = `ForgeWrapper-${handler.options.overrides.fw.version}.jar`;
      const fwPathArr = ['io', 'github', 'zekerzhayard', 'ForgeWrapper', handler.options.overrides.fw.version];
      json.libraries.push({
        name: fwPathArr.join(':'),
        downloads: {
          artifact: {
            path: [...fwPathArr, fwName].join('/'),
            url: `${handler.options.overrides.fw.baseUrl}${handler.options.overrides.fw.version}/${fwName}`,
            sha1: handler.options.overrides.fw.sh1,
            size: handler.options.overrides.fw.size
          }
        }
      });
      json.mainClass = 'io.github.zekerzhayard.forgewrapper.installer.Main';
      jarEnding = 'launcher';

      for (const library of (json.mavenFiles || [])) {
        const lib = library.name.split(':');
        if ((lib[0] === 'net.minecraftforge' && lib[1].includes('forge')) || (lib[0] === 'net.neoforged' && lib[1].includes('neoforge'))) {
          if (library.downloads?.artifact?.path && (!library.downloads.artifact.url)) {
            const repoBase = lib[0] === 'net.neoforged' ? 'https://maven.neoforged.net/releases/' : handler.options.overrides.url.mavenForge;
            library.downloads.artifact.url = repoBase + library.downloads.artifact.path;
          }
          break;
        }
      }
    } else if (Array.isArray(json.mavenFiles)) {
      json.mavenFiles = json.mavenFiles.filter((/** @type {any} */ entry) => {
        const lib = entry?.name?.split(':');
        return !(lib && ((lib[0] === 'net.minecraftforge' && lib[1].includes('forge')) || (lib[0] === 'net.neoforged' && lib[1].includes('neoforge'))));
      });
    }
  } else {
    await pMap(json.libraries || [], 16, async (/** @type {any} */ library) => {
      if (handler.client && handler.client.aborted) throw new Error('Launch aborted by user');
      const lib = library.name.split(':');
      if ((lib[0] === 'net.minecraftforge' && lib[1].includes('forge')) || (lib[0] === 'net.neoforged' && lib[1].includes('neoforge'))) return;

      let url = handler.options.overrides.url.mavenForge;
      const name = `${lib[1]}-${lib[2]}.jar`;

      if (!library.url) {
        if (library.serverreq || library.clientreq) {
          url = handler.options.overrides.url.defaultRepoForge;
        } else {
          return;
        }
      }
      library.url = url;
      if (handler.options && handler.options.offline) return;
      const downloadLink = `${url}${lib[0].replace(/\./g, '/')}/${lib[1]}/${lib[2]}/${name}`;
      await handler.baseRequest(downloadLink, (/** @type {any} */ error, /** @type {any} */ response) => {
        if (error) {
          handler.client.emit('debug', `[Gens-Core]: Failed checking request for ${downloadLink}`);
        } else if (response.statusCode === 404) {
          library.url = handler.options.overrides.url.fallbackMaven;
        }
      });
    });
  }

  if (json.libraries && json.libraries[0] && json.libraries[0].downloads) {
    const name = json.libraries[0].name;
    if ((name.includes('minecraftforge:forge') || name.includes('net.neoforged:neoforge')) && !name.includes('universal')) {
      json.libraries[0].name = name + `:${jarEnding}`;
      json.libraries[0].downloads.artifact.path = json.libraries[0].downloads.artifact.path.replace('.jar', `-${jarEnding}.jar`);
      const repoBase = name.includes('net.neoforged:') ? 'https://maven.neoforged.net/releases/' : handler.options.overrides.url.mavenForge;
      if (!json.libraries[0].downloads.artifact.url || !name.includes('net.neoforged:')) {
        json.libraries[0].downloads.artifact.url = repoBase + json.libraries[0].downloads.artifact.path;
      }
    }
  } else if (json.libraries && json.libraries[0]) {
    delete json.libraries[0];
  }

  json.libraries = handler.cleanUp(json.libraries);
  if (json.mavenFiles) json.mavenFiles = handler.cleanUp(json.mavenFiles);

  json.forgeWrapperVersion = handler.options.overrides.fw.version;

  if (!(await existsAsync(path.join(handler.options.root, 'forge', handler.version.id)))) {
    await fs.promises.mkdir(path.join(handler.options.root, 'forge', handler.version.id), { recursive: true });
  }
  await writeFileAtomic(versionPath, JSON.stringify(json, null, 4));

  if (handler.isModernForge(json)) handler.options.forge = null;

  return json;
}

module.exports = { resolveForgedWrapped };
