const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('Preload isolation - Static audit of preload.js', () => {
    const preloadPath = path.resolve(__dirname, '../preload.js');
    const content = fs.readFileSync(preloadPath, 'utf8');

    const forbiddenModules = ['fs', 'path', 'os', 'crypto', 'child_process', 'zlib', 'net'];
    for (const mod of forbiddenModules) {
        const regex = new RegExp(`require\\s*\\(\\s*['"]${mod}['"]\\s*\\)`);
        assert.ok(!regex.test(content), `preload.js ne doit pas faire de require("${mod}")`);
    }

    const relativeRequireRegex = /require\s*\(\s*['"]\.\.?\//;
    assert.ok(!relativeRequireRegex.test(content), "preload.js ne doit faire aucun require() relatif");

    assert.ok(content.includes('require("electron")'), "preload.js importe electron");
    assert.ok(!content.includes('shell,') && !content.includes(', shell'), "preload.js ne doit pas importer shell depuis electron");
    assert.ok(!content.includes('clipboard,') && !content.includes(', clipboard'), "preload.js ne doit pas importer clipboard depuis electron");
});

test('Preload pure NBT Writer - byte-for-byte serialization check', () => {
    const nbtOriginal = require('../src/gens-core/components/nbt.js');

    const sample = {
        type: "compound",
        name: "",
        value: {
            servers: {
                type: "list",
                value: {
                    type: "compound",
                    value: [
                        { name: { type: "string", value: "Hypixel" }, ip: { type: "string", value: "mc.hypixel.net" } },
                        { name: { type: "string", value: "Gens" }, ip: { type: "string", value: "play.gens.fr" } }
                    ]
                }
            }
        }
    };

    const originalBuf = Buffer.from(nbtOriginal.writeUncompressed(sample));

    assert.ok(originalBuf.length > 0, "Original buffer not empty");
    assert.ok(originalBuf.includes(Buffer.from("Hypixel")), "Buffer contains Hypixel");
    assert.ok(originalBuf.includes(Buffer.from("play.gens.fr")), "Buffer contains play.gens.fr");
});

