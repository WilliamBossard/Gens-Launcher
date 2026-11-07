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
    }

    /**
     * Gets the IPC pipe path for Discord on the current OS.
     * @param {number} id
     * @returns {string}
     */
    getIpcPath(id) {
        if (process.platform === 'win32') {
            return `\\\\?\\pipe\\discord-ipc-${id}`;
        }
        const { env } = process;
        const prefix = env.XDG_RUNTIME_DIR || env.TMPDIR || env.TMP || env.TEMP || '/tmp';
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
            const tryConnect = (id) => {
                if (id > 9) {
                    if (!this.manualDisconnect) this.scheduleReconnect();
                    return resolve(false);
                }

                const ipcPath = this.getIpcPath(id);
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
                        resolve(true);
                    }
                };

                connectTimeout = setTimeout(() => {
                    finishConnect(false);
                }, 2000);

                socket.once('data', (data) => {
                    finishConnect(true);
                    this.handleData(data);
                });

                socket.once('connect', () => {
                    this.handshake(socket);
                });

                socket.once('error', () => {
                    finishConnect(false);
                });

                socket.on('close', () => {
                    if (!resolved) {
                        finishConnect(false);
                        return;
                    }
                    this.connected = false;
                    this.socket = null;
                    if (!this.manualDisconnect) {
                        this.scheduleReconnect();
                    }
                });

                socket.on('data', (data) => {
                    if (resolved) this.handleData(data);
                });
            };

            tryConnect(0);
        });
    }

    scheduleReconnect() {
        if (this.manualDisconnect) return;
        if (!this.reconnectTimer) {
            this.reconnectTimer = setTimeout(() => {
                this.reconnectTimer = null;
                if (!this.manualDisconnect) this.connect();
            }, 5000);
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
        // Simple handler, full protocol parsing not strictly needed for basic usage 
        // since we only SEND status updates, but we need to read to keep buffer clean.
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
        this.connected = false;
    }
}

module.exports = DiscordRPC;
