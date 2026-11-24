// @ts-check
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns');
const https = require('https');
const net = require('net');
const { Readable } = require('stream');
const { pipeStreams } = require('../../main/zip-utils');
const { existsAsync } = require('./zip-archive');

const nativeFetch = global.fetch;

/**
 * Écrit un fichier de manière atomique via un fichier temporaire et un rename avec retry Windows.
 * @param {string} filePath
 * @param {string | Buffer | Uint8Array} data
 * @param {BufferEncoding | null} [encoding='utf8']
 */
async function writeFileAtomic(filePath, data, encoding = 'utf8') {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const randSuffix = crypto.randomBytes(4).toString('hex');
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${randSuffix}`;
  try {
    if (encoding && typeof data === 'string') {
      await fs.promises.writeFile(tmpPath, data, encoding);
    } else {
      await fs.promises.writeFile(tmpPath, data);
    }
    let renamed = false;
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await fs.promises.rename(tmpPath, filePath);
        renamed = true;
        break;
      } catch (err) {
        lastErr = err;
        const errAny = /** @type {any} */ (err);
        if (errAny && (errAny.code === 'EPERM' || errAny.code === 'EBUSY' || errAny.code === 'EACCES') && attempt < 3) {
          await new Promise(r => setTimeout(r, 40 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
    if (!renamed && lastErr) throw lastErr;
  } finally {
    try { await fs.promises.unlink(tmpPath); } catch (_) {}
  }
}

/**
 * Executes an async callback on an array of items with bounded concurrency, preserving order.
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
  /** @type {any} */
  let abortedErr = null;
  for (let i = 0; i < array.length; i++) {
    if (abortedErr) break;
    const p = Promise.resolve().then(() => asyncCallback(array[i], i, array));
    p.catch((err) => {
      if (!abortedErr) abortedErr = err;
    });
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
  const settled = await Promise.allSettled(results);
  const firstRejected = settled.find((s) => s.status === 'rejected');
  if (firstRejected) {
    throw firstRejected.reason;
  }
  return settled.map((s) => /** @type {PromiseFulfilledResult<R>} */ (s).value);
}

/**
 * Vérifie qu'une URL distante est bien en HTTPS et ne pointe pas vers un hôte local/privé (anti-SSRF).
 * @param {string} rawUrl
 * @param {any} [client]
 * @returns {URL}
 */
function assertSafeRemoteUrl(rawUrl, client) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'https:') {
    client?.emit('debug', `[Gens-Core]: Blocked non-HTTPS URL: ${rawUrl}`);
    throw new Error(`Blocked non-HTTPS URL: ${rawUrl}`);
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isPrivateOrLocalHost(host)) {
    client?.emit('debug', `[Gens-Core]: Blocked private/local host: ${host}`);
    throw new Error(`Blocked private/local host: ${host}`);
  }
  return parsed;
}

/**
 * @param {string} rawUrl
 * @param {any} [client]
 * @param {((hostname: string, opts: { all: true }) => Promise<Array<{ address: string; family?: number }>>) | null} [lookupFn]
 * @returns {Promise<{ url: URL; pinnedRecord: { address: string; family: number } | null }>}
 */
async function resolveAndValidateRemoteUrl(rawUrl, client = null, lookupFn = null) {
  const parsed = assertSafeRemoteUrl(rawUrl, client);
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  /** @type {{ address: string; family: number } | null} */
  let pinnedRecord = null;
  if (!net.isIP(host)) {
    const doLookup = lookupFn || ((/** @type {string} */ h, /** @type {{ all: true }} */ o) => dns.promises.lookup(h, o));
    try {
      const records = await doLookup(host, { all: true });
      for (const rec of records || []) {
        if (rec && rec.address && isPrivateOrLocalHost(rec.address)) {
          client?.emit('debug', `[Gens-Core]: Blocked private/local DNS target for ${host}: ${rec.address}`);
          throw new Error(`Blocked private/local host: ${host} (${rec.address})`);
        }
      }
      const first = (records || []).find(r => r && r.address && net.isIP(r.address));
      if (first) {
        pinnedRecord = {
          address: first.address,
          family: first.family || (net.isIP(first.address) === 6 ? 6 : 4)
        };
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('Blocked ')) {
        throw e;
      }
      // En cas d'échec DNS (ex: offline ou tests mockant global.fetch), on laisse fetch gérer l'erreur réseau.
    }
  }
  return { url: parsed, pinnedRecord };
}

/**
 * @param {string} rawUrl
 * @param {any} [client]
 * @param {((hostname: string, opts: { all: true }) => Promise<Array<{ address: string; family?: number }>>) | null} [lookupFn]
 * @returns {Promise<URL>}
 */
async function assertSafeRemoteUrlAsync(rawUrl, client = null, lookupFn = null) {
  const { url } = await resolveAndValidateRemoteUrl(rawUrl, client, lookupFn);
  return url;
}

/**
 * Exécute une requête HTTPS en épinglant l'IP résolue pour prévenir le DNS rebinding.
 * @param {string} urlStr
 * @param {RequestInit} fetchInit
 * @param {{ address: string; family: number }} pinnedRecord
 * @returns {Promise<any>}
 */
function pinnedHttpsRequest(urlStr, fetchInit, pinnedRecord) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const reqHeaders = /** @type {Record<string, string>} */ ({});
    if (fetchInit.headers) {
      if (typeof /** @type {any} */ (fetchInit.headers).forEach === 'function') {
        /** @type {Headers} */ (fetchInit.headers).forEach((v, k) => { reqHeaders[k] = v; });
      } else if (Array.isArray(fetchInit.headers)) {
        for (const [k, v] of fetchInit.headers) reqHeaders[k] = v;
      } else {
        Object.assign(reqHeaders, fetchInit.headers);
      }
    }

    /** @type {import('https').RequestOptions} */
    const reqOpts = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: fetchInit.method || 'GET',
      headers: reqHeaders,
      lookup: (_hostname, opts, cb) => {
        if (opts && typeof opts === 'object' && opts.all) {
          return cb(null, [{ address: pinnedRecord.address, family: pinnedRecord.family }]);
        }
        return cb(null, pinnedRecord.address, pinnedRecord.family);
      }
    };

    const req = https.request(reqOpts, (res) => {
      const status = res.statusCode || 0;
      const statusText = res.statusMessage || '';
      const headers = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (Array.isArray(v)) {
          for (const item of v) headers.append(k, item);
        } else if (v !== undefined) {
          headers.set(k, v);
        }
      }
      const webBody = Readable.toWeb(res);
      /** @type {Promise<string> | null} */
      let textPromise = null;
      const readAllText = () => {
        if (!textPromise) {
          textPromise = new Promise((resText, rejText) => {
            const chunks = /** @type {Buffer[]} */ ([]);
            res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
            res.on('end', () => resText(Buffer.concat(chunks).toString('utf8')));
            res.on('error', rejText);
          });
        }
        return textPromise;
      };
      resolve({
        ok: status >= 200 && status < 300,
        status,
        statusText,
        headers,
        body: webBody,
        text: readAllText,
        json: async () => JSON.parse(await readAllText())
      });
    });

    const signal = fetchInit.signal;
    const onAbort = () => {
      req.destroy(new Error('The operation was aborted'));
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => signal.removeEventListener('abort', onAbort));
    }

    req.on('error', reject);
    if (fetchInit.body != null && typeof fetchInit.body === 'string') {
      req.write(fetchInit.body);
    } else if (fetchInit.body != null && Buffer.isBuffer(fetchInit.body)) {
      req.write(fetchInit.body);
    }
    req.end();
  });
}

/**
 * Exécute fetch() avec suivi manuel des redirections et revalidation HTTPS + anti-SSRF à chaque hop.
 * @param {string} rawUrl
 * @param {RequestInit & { lookupFn?: (hostname: string, opts: { all: true }) => Promise<Array<{ address: string; family?: number }>> }} [init]
 * @param {any} [client]
 * @param {number} [maxRedirects]
 * @returns {Promise<Response>}
 */
async function fetchWithSafeRedirects(rawUrl, init = {}, client = null, maxRedirects = 5) {
  const { lookupFn, ...fetchInit } = init || {};
  let currentUrl = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const { pinnedRecord } = await resolveAndValidateRemoteUrl(currentUrl, client, lookupFn || null);
    const usePinned = global.fetch === nativeFetch && pinnedRecord !== null;
    const res = usePinned
      ? await pinnedHttpsRequest(currentUrl, fetchInit, pinnedRecord)
      : await fetch(currentUrl, { ...fetchInit, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) {
        throw new Error(`Redirect (${res.status}) without Location header`);
      }
      try { await res.body?.cancel(); } catch (_) {}
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    return res;
  }
  throw new Error(`Too many redirects (>${maxRedirects}) for ${rawUrl}`);
}

/**
 * @param {string} url
 * @param {((err: any, res: any, body: any) => void) | null} [cb]
 */
async function baseRequest(url, cb) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetchWithSafeRedirects(url, { method: 'HEAD', signal: controller.signal });
    clearTimeout(timer);
    if (cb) cb(null, { statusCode: res.status }, null);
  } catch (e) {
    clearTimeout(timer);
    if (cb) cb(e, null, null);
  }
}

/**
 * @param {string} url
 * @returns {Promise<string>}
 */
async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  const MAX_TEXT_BYTES = 32 * 1024 * 1024;
  try {
    const res = await fetchWithSafeRedirects(url, { signal: controller.signal });
    if (!res.ok) throw new Error(res.statusText);
    const cl = parseInt(res.headers?.get?.('content-length') || '0', 10) || 0;
    if (cl > MAX_TEXT_BYTES) {
      try { await res.body?.cancel(); } catch (_) {}
      throw new Error(`Response too large (${cl} bytes > ${MAX_TEXT_BYTES})`);
    }
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
      throw new Error(`Response body exceeds ${MAX_TEXT_BYTES} bytes`);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Vérifie qu'un hôte distant n'est ni loopback ni réseau privé/link-local (anti-SSRF).
 * Gère également 0.0.0.0, ::, IPv4-mapped IPv6, CGNAT 100.64.0.0/10, multicast et préfixes réservés.
 * @param {string} hostname
 * @returns {boolean}
 */
function isPrivateOrLocalHost(hostname) {
  const dlHost = hostname.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0].replace(/\.+$/, '');
  if (
    !dlHost ||
    dlHost === 'localhost' ||
    dlHost.endsWith('.local') ||
    dlHost.endsWith('.internal') ||
    dlHost === '0.0.0.0' ||
    dlHost === '::' ||
    dlHost === '::1' ||
    /^(?:0{1,4}:){7}0{0,3}[01]$/.test(dlHost)
  ) {
    return true;
  }

  // Extraction d'une IPv4 mappée dans IPv6 (notation pointée ou hexadécimale générée par WHATWG URL)
  const v4MappedDotted = dlHost.match(/^(?:::ffff:|0:0:0:0:0:ffff:)(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4MappedDotted) {
    return isPrivateOrLocalHost(v4MappedDotted[1]);
  }
  const v4MappedHex = dlHost.match(/^(?:::ffff:|0:0:0:0:0:ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (v4MappedHex) {
    const hi = parseInt(v4MappedHex[1], 16);
    const lo = parseInt(v4MappedHex[2], 16);
    const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isPrivateOrLocalHost(ipv4);
  }

  return (
    /^0\./.test(dlHost) ||
    /^127\./.test(dlHost) ||
    /^10\./.test(dlHost) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(dlHost) ||
    /^192\.168\./.test(dlHost) ||
    /^192\.0\.[02]\./.test(dlHost) ||
    /^198\.1[89]\./.test(dlHost) ||
    /^198\.51\.100\./.test(dlHost) ||
    /^203\.0\.113\./.test(dlHost) ||
    /^169\.254\./.test(dlHost) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(dlHost) ||
    /^(22[4-9]|23\d|24\d|25[0-5])\./.test(dlHost) ||
    /^f[cd][0-9a-f]{2}:|^fe[89ab][0-9a-f]:|^ff[0-9a-f]{2}:|^100::/i.test(dlHost)
  );
}

/**
 * Télécharge de façon atomique (fichier temporaire + renommage avec retry Windows) un fichier HTTPS.
 * @param {string} url
 * @param {string} directory
 * @param {string} name
 * @param {boolean} retry
 * @param {string} type
 * @param {{ client: any; options: any }} ctx
 * @returns {Promise<any>}
 */
async function downloadFileAsync(url, directory, name, retry, type, ctx) {
  const { client, options } = ctx;
  if (client && client.aborted) throw new Error("Launch aborted by user");
  if (options && options.offline) return path.join(directory, name);
  try {
    assertSafeRemoteUrl(url, client);
  } catch (_) {
    return { failed: true, asset: null };
  }
  const resolvedDir = path.resolve(directory);
  const finalPath = path.resolve(resolvedDir, name);
  const normDir = process.platform === 'win32' ? resolvedDir.toLowerCase() : resolvedDir;
  const normFinal = process.platform === 'win32' ? finalPath.toLowerCase() : finalPath;
  if (!normFinal.startsWith(normDir + path.sep)) {
    client?.emit('debug', `[Gens-Core]: Blocked path traversal target: ${finalPath}`);
    return { failed: true, asset: null };
  }
  if (!(await existsAsync(resolvedDir))) {
    await fs.promises.mkdir(resolvedDir, { recursive: true });
  }
  await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
  const controller = new AbortController();
  const INACTIVITY_TIMEOUT_MS = 45000;
  /** @type {NodeJS.Timeout} */
  let timeoutId = setTimeout(() => controller.abort(), INACTIVITY_TIMEOUT_MS);
  const resetInactivityTimer = () => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => controller.abort(), INACTIVITY_TIMEOUT_MS);
  };
  /** @type {Response} */
  let response;
  try {
    response = await fetchWithSafeRedirects(url, { signal: controller.signal }, client);
  } catch (err) {
    clearTimeout(timeoutId);
    const msg = err instanceof Error ? err.message : '';
    const isSecurityOrRedirectBlock = msg.startsWith('Blocked ') || msg.startsWith('Too many redirects');
    if (retry && !isSecurityOrRedirectBlock && (!client || !client.aborted)) {
      await new Promise(r => setTimeout(r, 350));
      return await downloadFileAsync(url, directory, name, false, type, ctx);
    }
    return { failed: true, asset: null };
  }

  if (!response.ok) {
    clearTimeout(timeoutId);
    try { await response.body?.cancel?.(); } catch (_) {}
    client?.emit('debug', `[Gens-Core]: Failed to download ${url} due to: ${response.status} ${response.statusText}`);
    const isRetryableHttp = response.status === 408 || response.status === 429 || response.status >= 500;
    if (retry && isRetryableHttp && (!client || !client.aborted)) {
      const retryAfterSec = parseInt(response.headers.get('retry-after') || '0', 10);
      const delayMs = retryAfterSec > 0 ? Math.min(2000, retryAfterSec * 1000) : 350;
      await new Promise(r => setTimeout(r, delayMs));
      return await downloadFileAsync(url, directory, name, false, type, ctx);
    }
    return { failed: true, asset: null };
  }

  const totalBytes = parseInt(response.headers.get('content-length') || '0', 10);
  let receivedBytes = 0;

  const randSuffix = crypto.randomBytes(4).toString('hex');
  const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}.${randSuffix}`;
  const dest = fs.createWriteStream(tmpPath);
  if (!response.body) {
    clearTimeout(timeoutId);
    dest.destroy();
    try { await fs.promises.unlink(tmpPath); } catch (_) {}
    return { failed: true, asset: null };
  }
  const bodyStream = Readable.fromWeb(/** @type {any} */ (response.body));

  bodyStream.on('data', (/** @type {Buffer} */ chunk) => {
    resetInactivityTimer();
    if (client && client.aborted) {
      dest.destroy(new Error("Launch aborted by user"));
      bodyStream.destroy();
      return;
    }
    receivedBytes += chunk.length;
    client?.emit('download-status', {
      name, type, current: receivedBytes, total: totalBytes
    });
  });

  try {
    await pipeStreams(bodyStream, dest);
    clearTimeout(timeoutId);
    let renamed = false;
    let lastRenameErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await fs.promises.rename(tmpPath, finalPath);
        renamed = true;
        break;
      } catch (renameErr) {
        lastRenameErr = renameErr;
        const errAny = /** @type {any} */ (renameErr);
        if (errAny && (errAny.code === 'EPERM' || errAny.code === 'EBUSY' || errAny.code === 'EACCES')) {
          await new Promise(r => setTimeout(r, 40 * (attempt + 1)));
        } else {
          throw renameErr;
        }
      }
    }
    if (!renamed && lastRenameErr) throw lastRenameErr;
    client?.emit('download', name);
    return { failed: false, asset: null };
  } catch (_) {
    clearTimeout(timeoutId);
    try { if (await existsAsync(tmpPath)) await fs.promises.unlink(tmpPath); } catch (_) {}
    if (retry && (!client || !client.aborted)) {
      return await downloadFileAsync(url, directory, name, false, type, ctx);
    }
    return { failed: true, asset: null };
  }
}

/**
 * Vérifie en streaming l'empreinte SHA-1 d'un fichier local.
 * @param {string} hash
 * @param {string} file
 * @param {any} [client]
 * @returns {Promise<boolean>}
 */
function checkSum(hash, file, client) {
  return new Promise((resolve) => {
    const hashStream = crypto.createHash('sha1');
    const fileStream = fs.createReadStream(file);

    /** @param {any} err */
    const onError = (err) => {
      client?.emit('debug', `[Gens-Core]: Failed to check file hash due to ${err}`);
      resolve(false);
    };

    fileStream.on('error', onError);
    hashStream.on('error', onError);

    hashStream.on('finish', () => {
      const sum = hashStream.read()?.toString('hex');
      resolve(typeof hash === 'string' && typeof sum === 'string' && hash.toLowerCase() === sum.toLowerCase());
    });

    fileStream.pipe(hashStream);
  });
}

/**
 * @param {string} filePath
 * @param {number} [expectedSize]
 * @param {string} [expectedSha1]
 * @param {{ fastSizeOnly?: boolean }} [opts]
 * @param {{ options?: any; checkSumFn: (hash: string, file: string) => Promise<boolean> }} [ctx]
 * @returns {Promise<boolean>}
 */
async function verifyFileFast(filePath, expectedSize, expectedSha1, opts, ctx) {
  try {
    const stat = await fs.promises.stat(filePath);
    if (typeof expectedSize === 'number' && expectedSize > 0 && stat.size !== expectedSize) {
      return false;
    }
    const fastMode = Boolean(opts?.fastSizeOnly ?? ctx?.options?.fastSizeOnly ?? ctx?.options?.offline);
    if (fastMode && stat.size > 0) {
      return true;
    }
    if (expectedSha1) {
      return await (ctx?.checkSumFn ? ctx.checkSumFn(expectedSha1, filePath) : checkSum(expectedSha1, filePath));
    }
    return stat.size > 0;
  } catch (_) {
    return false;
  }
}

module.exports = {
  pMap,
  baseRequest,
  fetchText,
  downloadFileAsync,
  writeFileAtomic,
  checkSum,
  verifyFileFast,
  isPrivateOrLocalHost,
  assertSafeRemoteUrl,
  assertSafeRemoteUrlAsync,
  fetchWithSafeRedirects
};
