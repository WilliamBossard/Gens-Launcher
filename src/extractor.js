const yauzl = require("yauzl");
const path = require("path");
const fs = require("fs");
const { pipeline } = require("stream/promises");

const zipPath = process.argv[2];
const destDir = process.argv[3];

if (!zipPath || !destDir) {
    console.error(JSON.stringify({ success: false, error: "Missing arguments" }));
    process.exit(1);
}

function sendMsg(msg) {
    console.log(JSON.stringify(msg));
}

function extractZip(zipPath, destDir) {
    const resolvedTarget = path.resolve(destDir);
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
        if (err) {
            sendMsg({ success: false, error: err.message });
            process.exit(1);
        }

        let processedCount = 0;
        const total = zipfile.entryCount;
        if (total === 0) {
            sendMsg({ success: true });
            process.exit(0);
        }

        zipfile.on("entry", async (entry) => {
            processedCount++;
            if (total > 0 && (processedCount % 10 === 0 || processedCount === total)) {
                sendMsg({ progress: true, percent: Math.round((processedCount / total) * 100) });
            }

            try {
                const dest = path.join(destDir, entry.fileName);
                const resDest = path.resolve(dest);
                if (!resDest.startsWith(resolvedTarget + path.sep) && resDest !== resolvedTarget) {
                    zipfile.readEntry(); return;
                }

                if (/\/$/.test(entry.fileName) || entry.fileName.endsWith('\\')) {
                    fs.mkdirSync(dest, { recursive: true });
                    zipfile.readEntry();
                } else {
                    fs.mkdirSync(path.dirname(dest), { recursive: true });
                    zipfile.openReadStream(entry, async (err, readStream) => {
                        if (err) {
                            sendMsg({ success: false, error: err.message });
                            process.exit(1);
                        }

                        const writeStream = fs.createWriteStream(dest);
                        try {
                            await pipeline(readStream, writeStream);
                            zipfile.readEntry();
                        } catch (pErr) {
                            sendMsg({ success: false, error: "Stream error: " + pErr.message });
                            process.exit(1);
                        }
                    });
                }
            } catch (err) {
                sendMsg({ success: false, error: err.message });
                process.exit(1);
            }
        });

        zipfile.on("end", () => {
            sendMsg({ success: true });
            process.exit(0);
        });

        zipfile.on("error", (zErr) => {
            sendMsg({ success: false, error: zErr.message });
            process.exit(1);
        });

        zipfile.readEntry();
    });
}

extractZip(zipPath, destDir);
