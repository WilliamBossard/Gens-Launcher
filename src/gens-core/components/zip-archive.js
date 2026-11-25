// @ts-check
const fs = require('fs');
const path = require('path');
const { Transform } = require('stream');
const { openZip, pipeStreams, readStreamBuffer } = require('../../main/zip-utils');

/**
 * Vérifie de manière asynchrone et non-bloquante l'existence d'un fichier ou dossier.
 * @param {string} targetPath
 * @returns {Promise<boolean>}
 */
async function existsAsync(targetPath) {
  try {
    await fs.promises.access(targetPath, fs.constants.F_OK);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Crée un flux Transform comptabilisant les octets extraits pour bloquer les zip-bombs.
 * @param {{ totalBytes: number }} state
 * @param {number} maxBytes
 * @returns {Transform}
 */
function createByteLimitTransform(state, maxBytes) {
  return new Transform({
    transform(chunk, _encoding, callback) {
      state.totalBytes += chunk.length;
      if (state.totalBytes > maxBytes) {
        callback(new Error('Zip bomb protection triggered'));
        return;
      }
      callback(null, chunk);
    }
  });
}

class Zip {
  /**
   * @param {string} zipPath
   */
  constructor(zipPath) {
    this.zipPath = zipPath;
  }

  /**
   * @param {string} dest
   * @param {boolean} [_overwrite]
   * @param {{ skipMetaInf?: boolean }} [opts]
   */
  async extractAllTo(dest, _overwrite, opts = {}) {
    await fs.promises.mkdir(dest, { recursive: true });
    const zipfile = await openZip(this.zipPath);
    const resolvedTarget = path.resolve(dest);
    const realTarget = await fs.promises.realpath(resolvedTarget);
    const isWin = process.platform === 'win32';
    const normTarget = isWin ? realTarget.toLowerCase() : realTarget;
    const createdDirs = new Set([resolvedTarget]);
    const MAX_ENTRIES = 10000;
    const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
    let entryCount = 0;
    const byteState = { totalBytes: 0 };
    /** @param {string} dir */
    const ensureDir = async (dir) => {
      if (createdDirs.has(dir)) return;
      // Vérifie le plus proche ancêtre existant AVANT mkdir pour empêcher la création hors cible via symlink
      let cur = path.resolve(dir);
      while (true) {
        try {
          const realCur = await fs.promises.realpath(cur);
          const relTail = path.relative(cur, path.resolve(dir));
          const projected = relTail ? path.join(realCur, relTail) : realCur;
          const normProjected = isWin ? projected.toLowerCase() : projected;
          if (!normProjected.startsWith(normTarget + path.sep) && normProjected !== normTarget) {
            throw new Error(`Zip symlink escape detected before mkdir: ${dir}`);
          }
          break;
        } catch (err) {
          if (err instanceof Error && err.message.startsWith('Zip symlink escape')) throw err;
          const parent = path.dirname(cur);
          if (parent === cur) break;
          cur = parent;
        }
      }
      await fs.promises.mkdir(dir, { recursive: true });
      const realDir = await fs.promises.realpath(dir);
      const normDir = isWin ? realDir.toLowerCase() : realDir;
      if (!normDir.startsWith(normTarget + path.sep) && normDir !== normTarget) {
        throw new Error(`Zip symlink escape detected in directory: ${dir}`);
      }
      createdDirs.add(dir);
    };
    try {
      for await (const entry of zipfile) {
        entryCount++;
        if (entryCount > MAX_ENTRIES) {
          throw new Error('Zip archive exceeds maximum allowed entry count');
        }
        const entryName = String(entry.filename || '').replace(/\\/g, '/');
        if (opts?.skipMetaInf && entryName.toUpperCase().startsWith('META-INF/')) {
          continue;
        }
        const externalAttr = (entry.externalFileAttributes >>> 16) & 0xFFFF;
        if ((externalAttr & 0o170000) === 0o120000) {
          continue;
        }
        const destPath = path.join(dest, entryName);
        const resDest = path.resolve(destPath);
        const normResDest = isWin ? resDest.toLowerCase() : resDest;
        const normResolvedTarget = isWin ? resolvedTarget.toLowerCase() : resolvedTarget;
        const isDirEntry = entryName.endsWith('/');
        const isInside = normResDest.startsWith(normResolvedTarget + path.sep);
        if (!isInside && !(isDirEntry && normResDest === normResolvedTarget)) {
          throw new Error(`Zip slip path traversal blocked: ${entryName}`);
        }
        if (isDirEntry) {
          await ensureDir(resDest);
        } else {
          if (typeof entry.uncompressedSize === 'number' && byteState.totalBytes + entry.uncompressedSize > MAX_TOTAL_BYTES) {
            throw new Error('Zip archive exceeds maximum uncompressed size');
          }
          await ensureDir(path.dirname(resDest));
          try {
            const st = await fs.promises.lstat(resDest);
            if (st.isSymbolicLink() || st.isDirectory()) {
              await fs.promises.rm(resDest, { recursive: true, force: true });
            }
          } catch (e) {
            if (e && /** @type {any} */ (e).code !== 'ENOENT') throw e;
          }
          const readStream = await entry.openReadStream();
          const byteLimiter = createByteLimitTransform(byteState, MAX_TOTAL_BYTES);
          const writeStream = fs.createWriteStream(resDest);
          try {
            await pipeStreams(readStream, byteLimiter, writeStream);
          } catch (pipeErr) {
            await fs.promises.rm(resDest, { force: true }).catch(() => {});
            throw pipeErr;
          }
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
      const zipfile = await openZip(this.zipPath);
      try {
        for await (const entry of zipfile) {
          if (entry.filename === fileName) {
            const readStream = await entry.openReadStream();
            const buf = await readStreamBuffer(readStream, 50 * 1024 * 1024);
            return buf.toString('utf8');
          }
        }
        return null;
      } finally {
        await zipfile.close();
      }
    } catch (_) {
      return null;
    }
  }

  /**
   * Lit plusieurs entrées texte en un seul parcours de l'archive ZIP.
   * @param {string[]} fileNames
   * @param {{ throwOnError?: boolean }} [options]
   * @returns {Promise<Record<string, string>>}
   */
  async readEntriesAsText(fileNames, options = {}) {
    /** @type {Record<string, string>} */
    const result = {};
    const pending = new Set(fileNames);
    if (pending.size === 0) return result;
    try {
      const zipfile = await openZip(this.zipPath);
      try {
        for await (const entry of zipfile) {
          if (pending.has(entry.filename)) {
            const readStream = await entry.openReadStream();
            const buf = await readStreamBuffer(readStream, 50 * 1024 * 1024);
            result[entry.filename] = buf.toString('utf8');
            pending.delete(entry.filename);
            if (pending.size === 0) break;
          }
        }
      } finally {
        await zipfile.close();
      }
    } catch (err) {
      if (options && options.throwOnError) throw err;
    }
    return result;
  }

  /**
   * Vérifie si une entrée existe dans l'archive ZIP.
   * @param {string} fileName
   * @returns {Promise<boolean>}
   */
  async getEntry(fileName) {
    try {
      const zipfile = await openZip(this.zipPath);
      try {
        for await (const entry of zipfile) {
          if (entry.filename === fileName) return true;
        }
        return false;
      } finally {
        await zipfile.close();
      }
    } catch (_) {
      return false;
    }
  }
}

module.exports = {
  Zip,
  existsAsync,
  createByteLimitTransform
};
