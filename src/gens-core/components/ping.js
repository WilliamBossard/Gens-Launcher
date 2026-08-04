const net = require('net');
const dns = require('dns');

function writeVarInt(value) {
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

function writeString(str) {
    const buffer = Buffer.from(str, 'utf8');
    return Buffer.concat([writeVarInt(buffer.length), buffer]);
}

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

async function pingServer(address, timeoutMs = 5000) {
    let host = address;
    let port = 25565;
    
    if (address.includes(':')) {
        const parts = address.split(':');
        host = parts[0];
        port = parseInt(parts[1], 10);
    } else {
        const srv = await resolveSrv(host);
        host = srv.host;
        port = srv.port;
    }

    return new Promise((resolve, reject) => {
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
            dataBuffer = Buffer.concat([dataBuffer, chunk]);
            
            const pktLenResult = readVarInt(dataBuffer, 0);
            if (!pktLenResult) return;
            
            const packetLength = pktLenResult.value;
            const packetLengthSize = pktLenResult.length;
            
            if (dataBuffer.length >= packetLength + packetLengthSize) {
                let offset = packetLengthSize;
                const idResult = readVarInt(dataBuffer, offset);
                offset += idResult.length;
                
                if (idResult.value !== 0x00) return reject(new Error("Invalid packet ID"));
                
                const jsonLenResult = readVarInt(dataBuffer, offset);
                offset += jsonLenResult.length;
                
                const jsonString = dataBuffer.toString('utf8', offset, offset + jsonLenResult.value);
                client.destroy();
                resolve(JSON.parse(jsonString));
            }
        });

        client.on('error', reject);
        client.on('timeout', () => {
            client.destroy();
            reject(new Error("Timeout"));
        });
    });
}

module.exports = { pingServer };
