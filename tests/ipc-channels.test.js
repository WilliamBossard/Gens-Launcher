const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const REPO_ROOT = path.resolve(__dirname, '..');
const preloadPath = path.join(REPO_ROOT, 'preload.js');
const ipcTypesPath = path.join(REPO_ROOT, 'src', 'types', 'ipc.ts');

function loadFile(filePath) {
    return fs.readFileSync(filePath, 'utf8');
}

function extractChannelArray(fileContent, constName) {
    const escapedName = constName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('const\\s+' + escapedName + '\\b[\\s\\S]*?=\\s*\\[');
    const match = fileContent.match(re);
    if (!match) return null;

    const start = fileContent.indexOf('[', match.index + match[0].length - 1);
    if (start < 0) return null;

    const end = fileContent.indexOf(']', start);
    if (end < 0) return null;

    const inner = fileContent.slice(start + 1, end);
    return Array.from(inner.matchAll(/["']([^"']*)["']/g)).map((m) => m[1]);
}

function diff(source, target) {
    if (!source || !target) return null;
    const targetSet = new Set(target);
    return source.filter((ch) => !targetSet.has(ch));
}

const preloadSource = loadFile(preloadPath);
const ipcSource = loadFile(ipcTypesPath);

const preloadSend = extractChannelArray(preloadSource, 'validSendChannels');
const preloadInvoke = extractChannelArray(preloadSource, 'validInvokeChannels');
const preloadReceive = extractChannelArray(preloadSource, 'validReceiveChannels');

const ipcSend = extractChannelArray(ipcSource, 'SEND_CHANNELS');
const ipcInvoke = extractChannelArray(ipcSource, 'INVOKE_CHANNELS');
const ipcReceive = extractChannelArray(ipcSource, 'RECEIVE_CHANNELS');

test('preload.js expose les trois whitelists de canaux IPC', () => {
    for (const [name, list] of [
        ['validSendChannels', preloadSend],
        ['validInvokeChannels', preloadInvoke],
        ['validReceiveChannels', preloadReceive]
    ]) {
        assert.ok(
            Array.isArray(list) && list.length > 0,
            name + ' (preload.js) doit être un tableau non vide.'
        );
    }
});

test('Tous les canaux SEND d\'ipc.ts sont autorisés par la whitelist de preload.js', () => {
    const missingInPreload = diff(ipcSend, preloadSend);
    assert.ok(
        missingInPreload !== null,
        'SEND_CHANNELS (ipc.ts) et validSendChannels (preload.js) doivent tous deux être définis.'
    );
    assert.deepStrictEqual(
        missingInPreload,
        [],
        'Canaux SEND ignorés par la whitelist de preload.js : ' + missingInPreload.join(', ')
    );
});

test('Tous les canaux INVOKE d\'ipc.ts sont autorisés par la whitelist de preload.js', () => {
    const missingInPreload = diff(ipcInvoke, preloadInvoke);
    assert.ok(
        missingInPreload !== null,
        'INVOKE_CHANNELS (ipc.ts) et validInvokeChannels (preload.js) doivent tous deux être définis.'
    );
    assert.deepStrictEqual(
        missingInPreload,
        [],
        'Canaux INVOKE ignorés par la whitelist de preload.js : ' + missingInPreload.join(', ')
    );
});

test('Tous les canaux RECEIVE d\'ipc.ts sont autorisés par la whitelist de preload.js', () => {
    const missingInPreload = diff(ipcReceive, preloadReceive);
    assert.ok(
        missingInPreload !== null,
        'RECEIVE_CHANNELS (ipc.ts) et validReceiveChannels (preload.js) doivent tous deux être définis.'
    );
    assert.deepStrictEqual(
        missingInPreload,
        [],
        'Canaux RECEIVE ignorés par la whitelist de preload.js : ' + missingInPreload.join(', ')
    );
});

test('Aucun canal mort : preload.js ne déclare pas de canal inconnu de ipc.ts', () => {
    for (const [name, list] of [
        ['validSendChannels', preloadSend],
        ['validInvokeChannels', preloadInvoke],
        ['validReceiveChannels', preloadReceive],
        ['SEND_CHANNELS', ipcSend],
        ['INVOKE_CHANNELS', ipcInvoke],
        ['RECEIVE_CHANNELS', ipcReceive]
    ]) {
        assert.ok(
            Array.isArray(list) && list.length > 0,
            name + ' doit être un tableau non vide pour cette comparaison.'
        );
    }

    const missingInIpc = [
        ...diff(preloadSend, ipcSend),
        ...diff(preloadInvoke, ipcInvoke),
        ...diff(preloadReceive, ipcReceive)
    ];
    assert.deepStrictEqual(
        missingInIpc,
        [],
        'Canaux déclarés dans preload.js mais absents de src/types/ipc.ts : ' + missingInIpc.join(', ')
    );
});
