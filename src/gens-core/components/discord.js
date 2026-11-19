// @ts-check
const net = require('net');
const fs = require('fs');
const path = require('path');

class DiscordRPC {
    /**
     * @param {string} clientId
     */
    constructor(clientId) {
        this.clientId = clientId;
        /** @type {import('net').Socket | null} */
        this.socket = null;
        /** @type {boolean} */
        this.connected = false;
        /** @type {NodeJS.Timeout | null} */
        this.reconnectTimer = null;
        /** @type {NodeJS.Timeout | null} */
        this.activityTimeout = null;
        /** @type {boolean} */
        this.manualDisconnect = false;
        /** @type {number} */
        this.lastActivityUpdate = 0;
        /** @type {number} */
        this.reconnectAttempts = 0;
        /** @type {Buffer} */
        this._rxBuffer = Buffer.alloc(0);
    }

    /**
     * Gets the IPC pipe path for Discord on the current OS.
     * @param {number} id
     * @returns {Promise<string>}
     */
    async getIpcPath(id) {
        if (process.platform === 'win32') {
            return `\\\\?\\pipe\\discord-ipc-${id}`;
        }
        const { env } = process;
        const xdg = env.XDG_RUNTIME_DIR || '';
        const tmp = env.TMPDIR || env.TMP || env.TEMP || '/tmp';
        const candidates = [
            xdg ? path.join(xdg, `discord-ipc-${id}`) : '',
            xdg ? path.join(xdg, 'app', 'com.discordapp.Discord', `discord-ipc-${id}`) : '',
            xdg ? path.join(xdg, 'snap.discord', `discord-ipc-${id}`) : '',
            path.join(tmp, `discord-ipc-${id}`),
            `/tmp/discord-ipc-${id}`
        ].filter(Boolean);
        for (const p of candidates) {
            try {
                await fs.promises.access(p);
                return p;
            } catch (_) { }
        }
        const prefix = xdg || tmp;
        return path.join(prefix, `discord-ipc-${id}`);
    }

    /**
     * Attempts to connect to Discord's local IPC pipe.
     * @returns {Promise<boolean>}
     */
    async connect() {
        if (this.connected) return true;
        this.manualDisconnect = false;

        return new Promise((resolve) => {
            /**
             * @param {number} id
             */
            const tryConnect = async (id) => {
                if (this.manualDisconnect) return resolve(false);
                if (id > 9) {
                    if (!this.manualDisconnect) this.scheduleReconnect();
                    return resolve(false);
                }

                const ipcPath = await this.getIpcPath(id);
                if (this.manualDisconnect) return resolve(false);
                const socket = net.createConnection(ipcPath);

                let resolved = false;
                /** @type {NodeJS.Timeout | null} */
                let connectTimeout = null;

                /**
                 * @param {boolean} success
                 */
                const finishConnect = (success) => {
                    if (resolved) return;
                    resolved = true;
                    if (connectTimeout) clearTimeout(connectTimeout);
                    if (!success && socket) socket.destroy();
                    if (!success) {
                        tryConnect(id + 1);
                    } else {
                        this.socket = socket;
                        this.connected = true;
                        this.reconnectAttempts = 0;
                        this._rxBuffer = Buffer.alloc(0);
                        resolve(true);
                    }
                };

                connectTimeout = setTimeout(() => {
                    finishConnect(false);
                }, 2000);

                socket.once('connect', () => {
                    if (this.manualDisconnect) {
                        finishConnect(false);
                        return;
                    }
                    this.handshake(socket);
                });

                socket.on('error', () => {
                    if (!resolved) {
                        finishConnect(false);
                        return;
                    }
                    this.connected = false;
                    try { socket.destroy(); } catch (_) {}
                    if (this.socket === socket) this.socket = null;
                    this._rxBuffer = Buffer.alloc(0);
                });

                socket.on('close', () => {
                    if (!resolved) {
                        finishConnect(false);
                        return;
                    }
                    this.connected = false;
                    this.socket = null;
                    this._rxBuffer = Buffer.alloc(0);
                    if (!this.manualDisconnect) {
                        this.scheduleReconnect();
                    }
                });

                socket.on('data', (data) => {
                    if (!resolved) {
                        finishConnect(true);
                    }
                    this.handleData(data);
                });
            };

            tryConnect(0);
        });
    }

    scheduleReconnect() {
        const MAX_RECONNECT_ATTEMPTS = 10;
        if (this.manualDisconnect || this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) return;
        if (!this.reconnectTimer) {
            const delayMs = Math.min(60000, 5000 * Math.pow(2, this.reconnectAttempts));
            this.reconnectAttempts++;
            this.reconnectTimer = setTimeout(() => {
                this.reconnectTimer = null;
                if (!this.manualDisconnect) this.connect();
            }, delayMs);
        }
    }

    /**
     * Sends an IPC frame to Discord.
     * @param {number} opcode
     * @param {any} payload
     * @param {import('net').Socket | null} [targetSocket=null]
     */
    send(opcode, payload, targetSocket = null) {
        const sock = targetSocket || this.socket;
        if (!sock || sock.destroyed) return;

        const data = JSON.stringify(payload);
        const len = Buffer.byteLength(data);
        const packet = Buffer.alloc(8 + len);

        packet.writeInt32LE(opcode, 0);
        packet.writeInt32LE(len, 4);
        packet.write(data, 8, len);

        try {
            sock.write(packet);
        } catch (e) {
            sock.destroy();
        }
    }

    /**
     * Sends initial handshake frame.
     * @param {import('net').Socket} sock
     */
    handshake(sock) {
        this.send(0, { v: 1, client_id: this.clientId }, sock);
    }

    /**
     * @param {Buffer | string} data
     */
    handleData(data) {
        const MAX_RX_BUFFER = 1024 * 1024;
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (this._rxBuffer.length + chunk.length > MAX_RX_BUFFER) {
            this._rxBuffer = Buffer.alloc(0);
            if (this.socket && !this.socket.destroyed) {
                this.socket.destroy();
            }
            return;
        }
        this._rxBuffer = this._rxBuffer.length === 0 ? chunk : Buffer.concat([this._rxBuffer, chunk]);
        let offset = 0;
        while (offset + 8 <= this._rxBuffer.length) {
            const opcode = this._rxBuffer.readInt32LE(offset);
            const length = this._rxBuffer.readInt32LE(offset + 4);
            if (length < 0 || length > MAX_RX_BUFFER) {
                this._rxBuffer = Buffer.alloc(0);
                if (this.socket && !this.socket.destroyed) {
                    this.socket.destroy();
                }
                return;
            }
            if (offset + 8 + length > this._rxBuffer.length) {
                break;
            }
            offset += 8;
            const payloadBuf = this._rxBuffer.subarray(offset, offset + length);
            offset += length;

            if (opcode === 3) {
                // PING -> répondre PONG (opcode 4)
                let parsed = {};
                try { parsed = JSON.parse(payloadBuf.toString('utf8')); } catch (_) { }
                this.send(4, parsed);
            } else if (opcode === 2) {
                // CLOSE -> fermer proprement la socket Discord
                if (this.socket && !this.socket.destroyed) {
                    this.socket.destroy();
                }
            }
        }
        if (offset > 0) {
            this._rxBuffer = offset >= this._rxBuffer.length
                ? Buffer.alloc(0)
                : Buffer.from(this._rxBuffer.subarray(offset));
        }
    }

    /**
     * Sets Discord Rich Presence activity.
     * @param {Record<string, any>} activity
     */
    setActivity(activity) {
        if (!this.connected) return;

        const payload = {
            cmd: 'SET_ACTIVITY',
            args: {
                pid: process.pid,
                activity: activity
            },
            nonce: Date.now().toString()
        };

        this.queueActivity(payload);
    }

    /**
     * Clears current Discord Rich Presence activity.
     */
    clearActivity() {
        if (!this.connected) return;

        const payload = {
            cmd: 'SET_ACTIVITY',
            args: {
                pid: process.pid,
            },
            nonce: Date.now().toString()
        };

        this.queueActivity(payload);
    }

    /**
     * Throttles presence updates to respect Discord's rate limits (max 1 every 15s).
     * @param {any} payload
     */
    queueActivity(payload) {
        const now = Date.now();
        if (now - (this.lastActivityUpdate || 0) >= 15000) {
            this.lastActivityUpdate = now;
            this.send(1, payload);
        } else {
            if (this.activityTimeout) clearTimeout(this.activityTimeout);
            this.activityTimeout = setTimeout(() => {
                this.activityTimeout = null;
                this.lastActivityUpdate = Date.now();
                this.send(1, payload);
            }, 15000 - (now - this.lastActivityUpdate));
        }
    }

    /**
     * Closes the Discord connection and stops any reconnect attempts.
     */
    disconnect() {
        this.manualDisconnect = true;
        this.reconnectAttempts = 0;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.activityTimeout) {
            clearTimeout(this.activityTimeout);
            this.activityTimeout = null;
        }
        if (this.socket) {
            this.send(2, {}); // Close
            this.socket.destroy();
            this.socket = null;
        }
        this._rxBuffer = Buffer.alloc(0);
        this.connected = false;
    }
}

module.exports = DiscordRPC;
