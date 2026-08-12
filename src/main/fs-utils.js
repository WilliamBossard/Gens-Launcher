const fs = require('fs');

async function existsSafe(p) {
    try {
        if (typeof enforceReadSandbox !== 'undefined') p = enforceReadSandbox(p, true);
        await fs.promises.access(p);
        return true;
    } catch {
        return false;
    }
}

module.exports = { existsSafe };
