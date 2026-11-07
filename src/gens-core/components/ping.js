// @ts-check
const net = require('net');
const dns = require('dns');

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
                resolve({ host: addresses[0].name, port: addresses[0].port });
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
    let host = address;
    let port = 25565;
    
    if (typeof address === 'string') {
        const match = address.trim().match(/^(?:\[([a-fA-F0-9:]+)\]|([^:]+))(?::(\d+))?$/);
        if (match) {
            host = match[1] || match[2] || address;
            if (match[3]) {
                const parsedPort = parseInt(match[3], 10);
                if (!isNaN(parsedPort) && parsedPort >= 1 && parsedPort <= 65535) {
                    port = parsedPort;
                }
            } else {
                const srv = await resolveSrv(host);
                host = srv.host;
                port = srv.port;
            }
        } else {
            const srv = await resolveSrv(host);
            host = srv.host;
            port = srv.port;
        }
    }

    return new Promise((resolve, reject) => {
        let settled = false;
        /**
         * @param {(v: any) => void} fn
         * @param {any} val
         */
        const finish = (fn, val) => {
            if (settled) return;
            settled = true;
            fn(val);
        };

        const client = new net.Socket();
        client.setTimeout(timeoutMs);
        
        client.connect(port, host, () => {
            const packetId = writeVarInt(0x00);
            const protocol = writeVarInt(47); // Or use -1 for any
            const serverAddress = writeString(host);
            const serverPort = Buffer.alloc(2);
            serverPort.writeUInt16BE(port, 0);
            const nextState = writeVarInt(1);
            
            const payload = Buffer.concat([packetId, protocol, serverAddress, serverPort, nextState]);
            const handshake = Buffer.concat([writeVarInt(payload.length), payload]);
            
            const reqPayload = writeVarInt(0x00);
            const request = Buffer.concat([writeVarInt(reqPayload.length), reqPayload]);
            
            client.write(Buffer.concat([handshake, request]));
        });

        let dataBuffer = Buffer.alloc(0);

        client.on('data', (chunk) => {
            try {
                const bufChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                dataBuffer = Buffer.concat([dataBuffer, bufChunk]);
                
                const pktLenResult = readVarInt(dataBuffer, 0);
                if (!pktLenResult) return;
                
                const packetLength = pktLenResult.value;
                const packetLengthSize = pktLenResult.length;
                
                if (dataBuffer.length >= packetLength + packetLengthSize) {
                    let offset = packetLengthSize;
                    const idResult = readVarInt(dataBuffer, offset);
                    if (!idResult) return;
                    offset += idResult.length;
                    
                    if (idResult.value !== 0x00) {
                        client.destroy();
                        return finish(reject, new Error("Invalid packet ID"));
                    }
                    
                    const jsonLenResult = readVarInt(dataBuffer, offset);
                    if (!jsonLenResult) return;
                    offset += jsonLenResult.length;
                    
                    const jsonString = dataBuffer.toString('utf8', offset, offset + jsonLenResult.value);
                    client.destroy();
                    finish(resolve, JSON.parse(jsonString));
                }
            } catch (err) {
                client.destroy();
                finish(reject, err);
            }
        });

        client.on('error', (err) => finish(reject, err));
        client.on('timeout', () => {
            client.destroy();
            finish(reject, new Error("Timeout"));
        });
    });
}

module.exports = { pingServer };
