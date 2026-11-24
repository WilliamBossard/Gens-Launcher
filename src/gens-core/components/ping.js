// @ts-check
const net = require('net');
const dns = require('dns');
const { isPrivateOrLocalHost } = require('./network-utils');

/**
 * Encodes a number into a Minecraft VarInt Buffer.
 * @param {number} value
 * @returns {Buffer}
 */
function writeVarInt(value) {
    /** @type {number[]} */
    const buffer = [];
    while (true) {
        if ((value & 0xFFFFFF80) === 0) {
            buffer.push(value);
            return Buffer.from(buffer);
        }
        buffer.push(value & 0x7F | 0x80);
        value >>>= 7;
    }
}

/**
 * Reads a Minecraft VarInt from a Buffer at the given offset.
 * @param {Buffer} buffer
 * @param {number} offset
 * @returns {{ value: number, length: number } | null}
 */
function readVarInt(buffer, offset) {
    let numRead = 0;
    let result = 0;
    let read;
    do {
        if (offset + numRead >= buffer.length) return null;
        read = buffer[offset + numRead];
        let value = (read & 0b01111111);
        result |= (value << (7 * numRead));
        numRead++;
        if (numRead > 5) throw new Error("VarInt is too big");
    } while ((read & 0b10000000) !== 0);
    return { value: result, length: numRead };
}

/**
 * Writes a UTF-8 string prefixed with its VarInt length.
 * @param {string} str
 * @returns {Buffer}
 */
function writeString(str) {
    const buffer = Buffer.from(str, 'utf8');
    return Buffer.concat([writeVarInt(buffer.length), buffer]);
}

/**
 * Resolves Minecraft SRV DNS records for a given host.
 * @param {string} host
 * @returns {Promise<{ host: string, port: number }>}
 */
function resolveSrv(host) {
    return new Promise((resolve) => {
        let resolved = false;
        const timer = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                resolve({ host, port: 25565 });
            }
        }, 1500);

        dns.resolveSrv(`_minecraft._tcp.${host}`, (err, addresses) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            if (err || !addresses || addresses.length === 0) {
                resolve({ host, port: 25565 });
            } else {
                const sorted = [...addresses].sort((a, b) => (a.priority - b.priority) || (b.weight - a.weight));
                const best = sorted[0];
                const cleanTarget = String(best.name || host).replace(/\.+$/, '');
                resolve({ host: cleanTarget, port: best.port });
            }
        });
    });
}

/**
 * Pings a Minecraft server via Server List Ping (SLP) protocol.
 * @param {string} address - Hostname or IP with optional port (e.g. "mc.hypixel.net" or "localhost:25565")
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<any>} Server status response object
 */
async function pingServer(address, timeoutMs = 5000) {
    if (typeof address !== 'string' || !address.trim()) {
        throw new Error('Invalid or empty server address');
    }
    let originalHost = String(address);
    let connectHost = originalHost;
    let port = 25565;
    let usedSrv = false;
    
    if (typeof address === 'string') {
        const match = address.trim().match(/^(?:\[([a-fA-F0-9:]+)\]|([^:]+))(?::(\d+))?$/);
        if (match) {
            originalHost = (match[1] || match[2] || address).replace(/\.+$/, '');
            connectHost = originalHost;
            if (match[3]) {
                const parsedPort = parseInt(match[3], 10);
                if (!isNaN(parsedPort) && parsedPort >= 1 && parsedPort <= 65535) {
                    port = parsedPort;
                }
            } else {
                const srv = await resolveSrv(originalHost);
                connectHost = srv.host;
                port = srv.port;
                usedSrv = connectHost !== originalHost;
            }
        } else {
            const srv = await resolveSrv(originalHost);
            connectHost = srv.host;
            port = srv.port;
            usedSrv = connectHost !== originalHost;
        }
    }

    /** @param {string} addr */
    const isLinkLocalOrUnspecified = (addr) => {
        const clean = addr.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
        if (clean === '0.0.0.0' || clean === '::' || clean === '::ffff:0.0.0.0') return true;
        if (/^169\.254\./.test(clean) || /^fe[89ab][0-9a-f]:/i.test(clean)) return true;
        if (clean.startsWith('::ffff:')) {
            const mapped = clean.slice(7);
            if (/^169\.254\./.test(mapped) || mapped === '0.0.0.0') return true;
            if (/^a9fe:[0-9a-f]{1,4}$/i.test(mapped)) return true;
        }
        return false;
    };

    const cleanConnectHost = connectHost.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
    // Toujours bloquer les plages link-local/IMDS cloud (169.254.0.0/16, ::ffff:169.254.0.0/16, fe80::/10, 0.0.0.0)
    if (isLinkLocalOrUnspecified(cleanConnectHost)) {
        throw new Error(`Blocked unsafe ping target: ${connectHost}`);
    }
    // Bloquer toute redirection SRV vers un hôte privé/local (anti-SSRF DNS/SRV)
    if (usedSrv && isPrivateOrLocalHost(cleanConnectHost)) {
        throw new Error(`Blocked private SRV target: ${connectHost}`);
    }
    let pinnedConnectTarget = cleanConnectHost;
    if (!net.isIP(cleanConnectHost) && !isPrivateOrLocalHost(originalHost)) {
        try {
            const records = await dns.promises.lookup(cleanConnectHost, { all: true });
            for (const rec of records || []) {
                if (rec?.address && (
                    isLinkLocalOrUnspecified(rec.address) ||
                    (usedSrv && isPrivateOrLocalHost(rec.address))
                )) {
                    throw new Error(`Blocked unsafe DNS target for ${connectHost}: ${rec.address}`);
                }
            }
            // Épingle la première IP validée pour éliminer la fenêtre TOCTOU de DNS rebinding
            if (Array.isArray(records) && records.length > 0 && records[0]?.address) {
                pinnedConnectTarget = records[0].address;
            }
        } catch (err) {
            if (err instanceof Error && err.message.startsWith('Blocked ')) throw err;
        }
    }

    return new Promise((resolve, reject) => {
        let settled = false;
        /** @type {NodeJS.Timeout | null} */
        let overallTimer = null;
        const client = new net.Socket();
        /**
         * @param {(v: any) => void} fn
         * @param {any} val
         */
        const finish = (fn, val) => {
            if (settled) return;
            settled = true;
            if (overallTimer) {
                clearTimeout(overallTimer);
                overallTimer = null;
            }
            fn(val);
        };

        overallTimer = setTimeout(() => {
            client.destroy();
            finish(reject, new Error("Timeout"));
        }, timeoutMs + 500);

        /** @type {Buffer[]} */
        const chunks = [];
        let totalBytes = 0;
        let expectedTotalBytes = 0;
        let packetLengthSize = 0;
        let packetLength = 0;
        const MAX_PING_BYTES = 2 * 1024 * 1024;

        client.setTimeout(timeoutMs);

        client.on('error', (err) => {
            client.destroy();
            finish(reject, err);
        });
        client.on('close', () => {
            finish(reject, new Error("Connection closed prematurely"));
        });
        client.on('timeout', () => {
            client.destroy();
            finish(reject, new Error("Timeout"));
        });

        client.on('data', (chunk) => {
            try {
                const bufChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                if (totalBytes + bufChunk.length > MAX_PING_BYTES) {
                    client.destroy();
                    return finish(reject, new Error("Response too large"));
                }
                chunks.push(bufChunk);
                totalBytes += bufChunk.length;

                if (expectedTotalBytes === 0) {
                    const headerProbe = chunks.length === 1
                        ? chunks[0]
                        : Buffer.concat(chunks, Math.min(totalBytes, 5));
                    const pktLenResult = readVarInt(headerProbe, 0);
                    if (!pktLenResult) return;

                    packetLength = pktLenResult.value;
                    packetLengthSize = pktLenResult.length;
                    if (packetLength <= 0 || packetLength > MAX_PING_BYTES) {
                        client.destroy();
                        return finish(reject, new Error("Invalid packet length"));
                    }
                    expectedTotalBytes = packetLength + packetLengthSize;
                }

                if (totalBytes >= expectedTotalBytes) {
                    const dataBuffer = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, totalBytes);
                    let offset = packetLengthSize;
                    const idResult = readVarInt(dataBuffer, offset);
                    if (!idResult) {
                        client.destroy();
                        return finish(reject, new Error("Invalid packet ID header"));
                    }
                    offset += idResult.length;

                    if (idResult.value !== 0x00) {
                        client.destroy();
                        return finish(reject, new Error("Invalid packet ID"));
                    }

                    const jsonLenResult = readVarInt(dataBuffer, offset);
                    if (!jsonLenResult) {
                        client.destroy();
                        return finish(reject, new Error("Invalid JSON string length header"));
                    }
                    offset += jsonLenResult.length;
                    if (jsonLenResult.value < 0 || offset + jsonLenResult.value > expectedTotalBytes) {
                        client.destroy();
                        return finish(reject, new Error("Invalid JSON string length"));
                    }

                    const jsonString = dataBuffer.toString('utf8', offset, offset + jsonLenResult.value);
                    client.destroy();
                    finish(resolve, JSON.parse(jsonString));
                }
            } catch (err) {
                client.destroy();
                finish(reject, err);
            }
        });

        client.connect(port, pinnedConnectTarget, () => {
            const packetId = writeVarInt(0x00);
            const protocol = writeVarInt(47); // Or use -1 for any
            const serverAddress = writeString(originalHost);
            const serverPort = Buffer.alloc(2);
            serverPort.writeUInt16BE(port, 0);
            const nextState = writeVarInt(1);

            const payload = Buffer.concat([packetId, protocol, serverAddress, serverPort, nextState]);
            const handshake = Buffer.concat([writeVarInt(payload.length), payload]);

            const reqPayload = writeVarInt(0x00);
            const request = Buffer.concat([writeVarInt(reqPayload.length), reqPayload]);

            client.write(Buffer.concat([handshake, request]));
        });
    });
}

module.exports = { pingServer };
