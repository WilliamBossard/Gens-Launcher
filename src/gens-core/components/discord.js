const net = require('net');
const fs = require('fs');
const path = require('path');

class DiscordRPC {
    constructor(clientId) {
        this.clientId = clientId;
        this.socket = null;
        this.connected = false;
        this.reconnectTimer = null;
        this.activityTimeout = null;
        this.manualDisconnect = false;
    }

    getIpcPath(id) {
        if (process.platform === 'win32') {
            return `\\\\?\\pipe\\discord-ipc-${id}`;
        }
        const { env } = process;
        const prefix = env.XDG_RUNTIME_DIR || env.TMPDIR || env.TMP || env.TEMP || '/tmp';
        return path.join(prefix, `discord-ipc-${id}`);
    }

    async connect() {
        if (this.connected) return;
        this.manualDisconnect = false;

        return new Promise((resolve) => {
            const tryConnect = (id) => {
                if (id > 9) {
                    if (!this.manualDisconnect) this.scheduleReconnect();
                    return resolve(false);
                }

                const ipcPath = this.getIpcPath(id);
                const socket = net.createConnection(ipcPath);

                let resolved = false;
                let connectTimeout = null;

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

    handshake(sock) {
        this.send(0, { v: 1, client_id: this.clientId }, sock);
    }

    handleData(data) {
        // Simple handler, full protocol parsing not strictly needed for basic usage 
        // since we only SEND status updates, but we need to read to keep buffer clean.
    }

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
