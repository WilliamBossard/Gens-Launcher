// @ts-check
/**
 * ==============================================================================
 * GENS LAUNCHER - ZERO-DEPENDENCY STREAMING ZIP READER & WRITER (Node 24+)
 * ==============================================================================
 * Remplace yauzl, yauzl-promise et archiver en s'appuyant uniquement sur les
 * modules natifs Node.js (`fs`, `zlib.createDeflateRaw`, `zlib.createInflateRaw`,
 * `zlib.crc32`). Supporte UTF-8, Store/Deflate, CRC-32 vérifié et ZIP64.
 * ==============================================================================
 */

const fs = require('fs');
const zlib = require('zlib');
const { Readable, PassThrough, pipeline } = require('stream');

/**
 * Connecte une chaîne de flux Node.js jusqu'à complétion (compatible toute version TypeScript).
 * @param {...(Readable | import('stream').Writable)} streams
 * @returns {Promise<void>}
 */
function pipeStreams(...streams) {
    return new Promise((resolve, reject) => {
        /** @type {(streamList: unknown[], cb: (err?: Error | null) => void) => void} */ (
            /** @type {unknown} */ (pipeline)
        )(streams, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

/**
 * Lit intégralement un flux lisible en Buffer avec une borne maximale optionnelle.
 * @param {Readable} stream
 * @param {number} [maxBytes=Infinity]
 * @returns {Promise<Buffer>}
 */
function readStreamBuffer(stream, maxBytes = Infinity) {
    return new Promise((resolve, reject) => {
        /** @type {Buffer[]} */
        const chunks = [];
        let totalBytes = 0;
        let settled = false;
        stream.on('data', (/** @type {Buffer | string} */ chunk) => {
            if (settled) return;
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            totalBytes += buf.length;
            if (totalBytes > maxBytes) {
                settled = true;
                stream.destroy();
                reject(new Error(`Entrée ZIP dépasse la limite de ${maxBytes} octets`));
                return;
            }
            chunks.push(buf);
        });
        stream.on('error', (err) => {
            if (settled) return;
            settled = true;
            reject(err);
        });
        stream.on('end', () => {
            if (settled) return;
            settled = true;
            resolve(Buffer.concat(chunks));
        });
    });
}

const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CD_HEADER_SIG = 0x02014b50;
const LOCAL_HEADER_SIG = 0x04034b50;
const DATA_DESC_SIG = 0x08074b50;
const MAX_CD_BUFFER_BYTES = 256 * 1024 * 1024; // 256 Mo max pour le Central Directory
const WRITE_BATCH_BYTES = 256 * 1024; // Regroupe les petits chunks avant syscall fh.write
const utf8FatalDecoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Lit exactement `length` octets depuis un FileHandle à `position` (gère les lectures partielles).
 * @param {fs.promises.FileHandle} fh
 * @param {number} length
 * @param {number} position
 * @param {string} contextLabel
 * @returns {Promise<Buffer>}
 */
async function readExact(fh, length, position, contextLabel) {
    const buf = Buffer.allocUnsafe(length);
    let total = 0;
    while (total < length) {
        const { bytesRead } = await fh.read(buf, total, length - total, position + total);
        if (bytesRead <= 0) {
            throw new Error(`Lecture incomplète (${contextLabel})`);
        }
        total += bytesRead;
    }
    return buf;
}

/**
 * Décode le nom d'une entrée ZIP (UTF-8 explicite, ou UTF-8 strict en secours puis latin1).
 * @param {Buffer} nameBuf
 * @param {number} flags
 * @returns {string}
 */
function decodeZipFilename(nameBuf, flags) {
    if ((flags & 0x0800) !== 0) {
        return nameBuf.toString('utf8');
    }
    try {
        return utf8FatalDecoder.decode(nameBuf);
    } catch (_) {
        return nameBuf.toString('latin1');
    }
}

const PRECOMPRESSED_EXTS = new Set([
    '.jar', '.zip', '.gz', '.png', '.jpg', '.jpeg', '.ogg', '.mp3', '.webp', '.7z', '.rar'
]);

/**
 * Convertit une Date JS en heure/date MS-DOS (locales).
 * @param {Date} date
 * @returns {{ dosTime: number, dosDate: number }}
 */
function dateToDos(date) {
    const year = Math.max(1980, Math.min(2107, date.getFullYear()));
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const hours = date.getHours();
    const minutes = date.getMinutes();
    const seconds = Math.floor(date.getSeconds() / 2);
    return {
        dosTime: ((hours & 0x1f) << 11) | ((minutes & 0x3f) << 5) | (seconds & 0x1f),
        dosDate: (((year - 1980) & 0x7f) << 9) | ((month & 0x0f) << 5) | (day & 0x1f)
    };
}

/**
 * @param {string} entryName
 * @returns {boolean}
 */
function isPrecompressedName(entryName) {
    const dot = entryName.lastIndexOf('.');
    if (dot === -1) return false;
    return PRECOMPRESSED_EXTS.has(entryName.slice(dot).toLowerCase());
}

/**
 * Crée un Readable Node à lecture paresseuse sur une plage précise d'un FileHandle partagé.
 * Respecte la backpressure sans partager le pointeur d'offset OS ni fermer le handle parent.
 * @param {fs.promises.FileHandle} fh
 * @param {number} startOffset
 * @param {number} byteLength
 * @param {() => boolean} isClosedFn
 * @returns {Readable}
 */
function createHandleSliceStream(fh, startOffset, byteLength, isClosedFn) {
    let pos = startOffset;
    const end = startOffset + byteLength;
    let reading = false;

    return new Readable({
        highWaterMark: 64 * 1024,
        read(size) {
            if (reading) return;
            if (pos >= end) {
                this.push(null);
                return;
            }
            if (isClosedFn()) {
                this.destroy(new Error('Archive ZIP déjà fermée'));
                return;
            }
            reading = true;
            const toRead = Math.min(size || 65536, end - pos);
            const buf = Buffer.allocUnsafe(toRead);
            fh.read(buf, 0, toRead, pos).then(({ bytesRead }) => {
                reading = false;
                if (bytesRead <= 0) {
                    if (pos < end) {
                        this.destroy(new Error('Fin de fichier inattendue lors de la lecture ZIP'));
                    } else {
                        this.push(null);
                    }
                    return;
                }
                pos += bytesRead;
                this.push(bytesRead === toRead ? buf : buf.subarray(0, bytesRead));
            }).catch((err) => {
                reading = false;
                this.destroy(err);
            });
        }
    });
}

/**
 * Parse le champ extra ZIP64 (Header ID 0x0001) lorsqu'une taille ou un offset vaut 0xFFFFFFFF.
 * @param {Buffer} extraBuf
 * @param {number} uncomp32
 * @param {number} comp32
 * @param {number} offset32
 * @returns {{ uncompressedSize: number, compressedSize: number, localHeaderOffset: number }}
 */
function parseZip64Extra(extraBuf, uncomp32, comp32, offset32) {
    let uncompressedSize = uncomp32;
    let compressedSize = comp32;
    let localHeaderOffset = offset32;

    let pos = 0;
    while (pos + 4 <= extraBuf.length) {
        const headerId = extraBuf.readUInt16LE(pos);
        const dataSize = extraBuf.readUInt16LE(pos + 2);
        pos += 4;
        if (pos + dataSize > extraBuf.length) break;

        if (headerId === 0x0001) {
            let p = pos;
            if (uncomp32 === 0xffffffff && p + 8 <= pos + dataSize) {
                uncompressedSize = Number(extraBuf.readBigUInt64LE(p));
                p += 8;
            }
            if (comp32 === 0xffffffff && p + 8 <= pos + dataSize) {
                compressedSize = Number(extraBuf.readBigUInt64LE(p));
                p += 8;
            }
            if (offset32 === 0xffffffff && p + 8 <= pos + dataSize) {
                localHeaderOffset = Number(extraBuf.readBigUInt64LE(p));
            }
            break;
        }
        pos += dataSize;
    }

    return { uncompressedSize, compressedSize, localHeaderOffset };
}

/**
 * Ouvre une archive ZIP en lecture (compatible avec l'API async utilisée par yauzl-promise).
 * @param {string} zipPath
 * @returns {Promise<{
 *   entryCount: number,
 *   close: () => Promise<void>,
 *   [Symbol.asyncIterator]: () => AsyncGenerator<{
 *     filename: string,
 *     compressionMethod: number,
 *     compressedSize: number,
 *     uncompressedSize: number,
 *     crc32: number,
 *     externalFileAttributes: number,
 *     openReadStream: () => Promise<Readable>
 *   }, void, unknown>
 * }>}
 */
async function openZip(zipPath) {
    const fh = await fs.promises.open(zipPath, 'r');
    let closed = false;
    const safeClose = async () => {
        if (!closed) {
            closed = true;
            await fh.close();
        }
    };

    try {
        const stat = await fh.stat();
        const fileSize = stat.size;
        if (fileSize < 22) {
            throw new Error('Fichier trop petit pour être une archive ZIP valide');
        }

        // Recherche de l'EOCD dans les 65 557 derniers octets (taille EOCD 22 + commentaire max 65535)
        const tailLen = Math.min(fileSize, 65535 + 22);
        const tailOffset = fileSize - tailLen;
        const tailBuf = await readExact(fh, tailLen, tailOffset, 'EOCD ZIP');

        let eocdPos = -1;
        for (let i = tailLen - 22; i >= 0; i--) {
            if (tailBuf.readUInt32LE(i) === EOCD_SIG) {
                const commentLen = tailBuf.readUInt16LE(i + 20);
                if (i + 22 + commentLen === tailLen) {
                    eocdPos = i;
                    break;
                }
            }
        }
        if (eocdPos === -1) {
            throw new Error('End of Central Directory introuvable : archive ZIP invalide ou tronquée');
        }

        let entryCount = tailBuf.readUInt16LE(eocdPos + 10);
        let cdSize = tailBuf.readUInt32LE(eocdPos + 12);
        let cdOffset = tailBuf.readUInt32LE(eocdPos + 16);

        // Support ZIP64 EOCD Locator (20 octets juste avant l'EOCD)
        const absEocdOffset = tailOffset + eocdPos;
        if (absEocdOffset >= 20 && eocdPos >= 20 && tailBuf.readUInt32LE(eocdPos - 20) === ZIP64_EOCD_LOCATOR_SIG) {
            const zip64EocdOffset = Number(tailBuf.readBigUInt64LE(eocdPos - 12));
            if (zip64EocdOffset >= 0 && zip64EocdOffset + 56 <= fileSize) {
                const z64Buf = await readExact(fh, 56, zip64EocdOffset, 'ZIP64 EOCD');
                if (z64Buf.readUInt32LE(0) === ZIP64_EOCD_SIG) {
                    entryCount = Number(z64Buf.readBigUInt64LE(32));
                    cdSize = Number(z64Buf.readBigUInt64LE(40));
                    cdOffset = Number(z64Buf.readBigUInt64LE(48));
                }
            }
        }

        if (cdOffset < 0 || cdSize < 0 || cdOffset + cdSize > fileSize) {
            throw new Error('Central Directory hors limites : archive ZIP corrompue');
        }
        if (cdSize > MAX_CD_BUFFER_BYTES) {
            throw new Error(`Central Directory trop volumineux (${cdSize} octets)`);
        }

        const cdBuf = await readExact(fh, cdSize, cdOffset, 'Central Directory ZIP');

        /** @type {Array<{
         *   filename: string,
         *   compressionMethod: number,
         *   compressedSize: number,
         *   uncompressedSize: number,
         *   crc32: number,
         *   externalFileAttributes: number,
         *   relativeOffsetOfLocalHeader: number,
         *   openReadStream: () => Promise<Readable>
         * }>} */
        const entries = [];
        let cursor = 0;

        while (cursor < cdBuf.length) {
            if (cursor + 46 > cdBuf.length || cdBuf.readUInt32LE(cursor) !== CD_HEADER_SIG) {
                throw new Error('Entrée Central Directory invalide ou corrompue');
            }

            const flags = cdBuf.readUInt16LE(cursor + 8);
            const compressionMethod = cdBuf.readUInt16LE(cursor + 10);
            const expectedCrc32 = cdBuf.readUInt32LE(cursor + 16);
            const comp32 = cdBuf.readUInt32LE(cursor + 20);
            const uncomp32 = cdBuf.readUInt32LE(cursor + 24);
            const nameLen = cdBuf.readUInt16LE(cursor + 28);
            const extraLen = cdBuf.readUInt16LE(cursor + 30);
            const commentLen = cdBuf.readUInt16LE(cursor + 32);
            const externalFileAttributes = cdBuf.readUInt32LE(cursor + 38);
            const offset32 = cdBuf.readUInt32LE(cursor + 42);

            const headerTotalLen = 46 + nameLen + extraLen + commentLen;
            if (cursor + headerTotalLen > cdBuf.length) {
                throw new Error('Entrée Central Directory tronquée');
            }

            const nameBuf = cdBuf.subarray(cursor + 46, cursor + 46 + nameLen);
            const filename = decodeZipFilename(nameBuf, flags);

            const extraBuf = cdBuf.subarray(cursor + 46 + nameLen, cursor + 46 + nameLen + extraLen);
            const zip64Sizes = parseZip64Extra(extraBuf, uncomp32, comp32, offset32);

            cursor += headerTotalLen;

            const entryObj = {
                filename,
                compressionMethod,
                compressedSize: zip64Sizes.compressedSize,
                uncompressedSize: zip64Sizes.uncompressedSize,
                crc32: expectedCrc32,
                externalFileAttributes,
                relativeOffsetOfLocalHeader: zip64Sizes.localHeaderOffset,
                openReadStream: async () => {
                    if (closed) throw new Error('Archive ZIP fermée');
                    if ((flags & 0x0001) !== 0) {
                        throw new Error(`Entrée chiffrée non supportée : ${filename}`);
                    }
                    if (compressionMethod !== 0 && compressionMethod !== 8) {
                        throw new Error(`Méthode de compression ZIP non supportée (${compressionMethod}) pour ${filename}`);
                    }

                    if (entryObj.relativeOffsetOfLocalHeader + 30 > fileSize) {
                        throw new Error(`Local File Header hors limites pour ${filename}`);
                    }
                    const lfhBuf = await readExact(fh, 30, entryObj.relativeOffsetOfLocalHeader, `Local File Header (${filename})`);
                    if (lfhBuf.readUInt32LE(0) !== LOCAL_HEADER_SIG) {
                        throw new Error(`Local File Header invalide pour ${filename}`);
                    }

                    const lfhNameLen = lfhBuf.readUInt16LE(26);
                    const lfhExtraLen = lfhBuf.readUInt16LE(28);
                    const dataOffset = entryObj.relativeOffsetOfLocalHeader + 30 + lfhNameLen + lfhExtraLen;

                    if (dataOffset + entryObj.compressedSize > fileSize) {
                        throw new Error(`Données compressées hors limites pour ${filename}`);
                    }

                    const rawSlice = createHandleSliceStream(fh, dataOffset, entryObj.compressedSize, () => closed);
                    const decompressedStream = compressionMethod === 0
                        ? rawSlice
                        : rawSlice.pipe(zlib.createInflateRaw());

                    let runningCrc = 0;
                    let actualUncompressed = 0;
                    let finished = false;
                    const verifiedOut = new PassThrough();

                    const cleanupStreams = () => {
                        rawSlice.destroy();
                        if (decompressedStream !== rawSlice && typeof decompressedStream.destroy === 'function') {
                            decompressedStream.destroy();
                        }
                    };

                    /** @param {any} err */
                    const abortWithError = (err) => {
                        if (finished) return;
                        finished = true;
                        cleanupStreams();
                        verifiedOut.destroy(err);
                    };

                    rawSlice.on('error', abortWithError);
                    if (decompressedStream !== rawSlice) {
                        decompressedStream.on('error', abortWithError);
                    }
                    verifiedOut.once('close', () => {
                        if (!finished) {
                            finished = true;
                            cleanupStreams();
                        }
                    });

                    decompressedStream.on('data', (/** @type {Buffer} */ chunk) => {
                        if (finished) return;
                        actualUncompressed += chunk.length;
                        if (actualUncompressed > entryObj.uncompressedSize) {
                            abortWithError(new Error(`Taille décompressée supérieure à la taille déclarée pour ${filename}`));
                            return;
                        }
                        runningCrc = zlib.crc32(chunk, runningCrc);
                        if (!verifiedOut.write(chunk)) {
                            decompressedStream.pause();
                        }
                    });

                    verifiedOut.on('drain', () => {
                        if (!finished && typeof decompressedStream.resume === 'function') {
                            decompressedStream.resume();
                        }
                    });

                    decompressedStream.on('end', () => {
                        if (finished) return;
                        if ((runningCrc >>> 0) !== (entryObj.crc32 >>> 0)) {
                            abortWithError(new Error(`CRC-32 invalide pour ${filename} (attendu 0x${entryObj.crc32.toString(16)}, reçu 0x${(runningCrc >>> 0).toString(16)})`));
                            return;
                        }
                        if (actualUncompressed !== entryObj.uncompressedSize) {
                            abortWithError(new Error(`Taille décompressée incohérente pour ${filename}`));
                            return;
                        }
                        finished = true;
                        verifiedOut.end();
                    });

                    return verifiedOut;
                }
            };

            entries.push(entryObj);
        }

        return {
            entryCount: entries.length || entryCount,
            close: safeClose,
            async *[Symbol.asyncIterator]() {
                for (const entry of entries) {
                    yield entry;
                }
            }
        };
    } catch (err) {
        await safeClose();
        throw err;
    }
}

/**
 * Compresse une liste de fichiers vers un fichier ZIP en streaming (sans dépendance externe).
 * @param {string} destPath
 * @param {Array<{ fullPath: string; relativePath: string }>} files
 * @param {{ level?: number; onProgress?: (processed: number, total: number) => void; onWarning?: (err: Error) => void }} [options]
 * @returns {Promise<void>}
 */
async function writeZipFromFiles(destPath, files, options = {}) {
    const level = typeof options.level === 'number' ? options.level : 1;
    const onProgress = options.onProgress;
    const onWarning = options.onWarning;

    const fh = await fs.promises.open(destPath, 'w');
    let closed = false;
    /** @param {boolean} unlinkDest */
    const closeAndCleanup = async (unlinkDest) => {
        if (!closed) {
            closed = true;
            await fh.close().catch(() => {});
        }
        if (unlinkDest) {
            try { await fs.promises.unlink(destPath); } catch (_) {}
        }
    };

    /** @type {Array<{
     *   nameBuf: Buffer,
     *   flags: number,
     *   method: number,
     *   dosTime: number,
     *   dosDate: number,
     *   crc32: number,
     *   compressedSize: number,
     *   uncompressedSize: number,
     *   localHeaderOffset: number
     * }>} */
    const cdRecords = [];
    let offset = 0;

    /** @param {Buffer} buf */
    const writeAll = async (buf) => {
        let written = 0;
        while (written < buf.length) {
            const res = await fh.write(buf, written, buf.length - written, offset + written);
            written += res.bytesWritten;
        }
        offset += buf.length;
    };

    try {
        for (let i = 0; i < files.length; i++) {
            const { fullPath, relativePath } = files[i];
            let stat;
            try {
                stat = await fs.promises.stat(fullPath);
            } catch (/** @type {any} */ statErr) {
                if (onWarning) onWarning(statErr instanceof Error ? statErr : new Error(String(statErr)));
                continue;
            }

            const zipName = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
            const nameBuf = Buffer.from(zipName, 'utf8');
            const { dosTime, dosDate } = dateToDos(stat.mtime);
            const useStore = stat.size === 0 || isPrecompressedName(zipName);
            const method = useStore ? 0 : 8;
            // Bit 11 = UTF-8 ; Bit 3 = Data Descriptor (tailles/CRC après les données)
            const flags = 0x0800 | 0x0008;
            const localHeaderOffset = offset;
            const expectZip64Lfh = stat.size >= 0xffffffff;
            const lfhExtraLen = expectZip64Lfh ? 20 : 0;

            const lfh = Buffer.allocUnsafe(30 + nameBuf.length + lfhExtraLen);
            lfh.writeUInt32LE(LOCAL_HEADER_SIG, 0);
            lfh.writeUInt16LE(expectZip64Lfh ? 45 : 20, 4); // version needed: 4.5 (ZIP64) ou 2.0
            lfh.writeUInt16LE(flags, 6);
            lfh.writeUInt16LE(method, 8);
            lfh.writeUInt16LE(dosTime, 10);
            lfh.writeUInt16LE(dosDate, 12);
            lfh.writeUInt32LE(0, 14); // CRC (dans Data Descriptor)
            lfh.writeUInt32LE(expectZip64Lfh ? 0xffffffff : 0, 18); // Comp size
            lfh.writeUInt32LE(expectZip64Lfh ? 0xffffffff : 0, 22); // Uncomp size
            lfh.writeUInt16LE(nameBuf.length, 26);
            lfh.writeUInt16LE(lfhExtraLen, 28);
            nameBuf.copy(lfh, 30);
            if (expectZip64Lfh) {
                const extraOff = 30 + nameBuf.length;
                lfh.writeUInt16LE(0x0001, extraOff);
                lfh.writeUInt16LE(16, extraOff + 2);
                lfh.writeBigUInt64LE(0n, extraOff + 4);
                lfh.writeBigUInt64LE(0n, extraOff + 12);
            }
            await writeAll(lfh);

            let crc32 = 0;
            let uncompressedSize = 0;
            let compressedSize = 0;

            await new Promise((resolve, reject) => {
                const readStream = fs.createReadStream(fullPath);
                const compStream = useStore ? new PassThrough() : zlib.createDeflateRaw({ level });
                let settled = false;
                /** @type {Buffer[]} */
                let batchChunks = [];
                let batchLen = 0;
                let writeQueue = Promise.resolve();

                /** @param {any} err */
                const fail = (err) => {
                    if (settled) return;
                    settled = true;
                    readStream.destroy();
                    compStream.destroy();
                    reject(err);
                };

                const flushBatch = () => {
                    if (batchLen === 0 || settled) return writeQueue;
                    const toFlush = batchChunks.length === 1 ? batchChunks[0] : Buffer.concat(batchChunks, batchLen);
                    batchChunks = [];
                    batchLen = 0;
                    writeQueue = writeQueue.then(() => {
                        if (!settled) return writeAll(toFlush);
                    });
                    return writeQueue;
                };

                readStream.on('error', fail);
                compStream.on('error', fail);
                readStream.on('data', (/** @type {Buffer} */ chunk) => {
                    crc32 = zlib.crc32(chunk, crc32);
                    uncompressedSize += chunk.length;
                });

                compStream.on('data', (/** @type {Buffer} */ outChunk) => {
                    if (settled || outChunk.length === 0) return;
                    compressedSize += outChunk.length;
                    batchChunks.push(outChunk);
                    batchLen += outChunk.length;
                    if (batchLen >= WRITE_BATCH_BYTES) {
                        compStream.pause();
                        flushBatch().then(() => {
                            if (!settled) compStream.resume();
                        }).catch(fail);
                    }
                });

                compStream.on('end', () => {
                    flushBatch().then(() => {
                        if (!settled) {
                            settled = true;
                            resolve(undefined);
                        }
                    }).catch(fail);
                });

                readStream.pipe(compStream);
            });

            const unsignedCrc = crc32 >>> 0;
            const needZip64Entry = compressedSize >= 0xffffffff || uncompressedSize >= 0xffffffff;

            if (needZip64Entry) {
                const dd64 = Buffer.allocUnsafe(24);
                dd64.writeUInt32LE(DATA_DESC_SIG, 0);
                dd64.writeUInt32LE(unsignedCrc, 4);
                dd64.writeBigUInt64LE(BigInt(compressedSize), 8);
                dd64.writeBigUInt64LE(BigInt(uncompressedSize), 16);
                await writeAll(dd64);
            } else {
                const dd = Buffer.allocUnsafe(16);
                dd.writeUInt32LE(DATA_DESC_SIG, 0);
                dd.writeUInt32LE(unsignedCrc, 4);
                dd.writeUInt32LE(compressedSize, 8);
                dd.writeUInt32LE(uncompressedSize, 12);
                await writeAll(dd);
            }

            cdRecords.push({
                nameBuf,
                flags,
                method,
                dosTime,
                dosDate,
                crc32: unsignedCrc,
                compressedSize,
                uncompressedSize,
                localHeaderOffset
            });

            if (onProgress) onProgress(i + 1, files.length);
        }

        const cdOffset = offset;
        /** @type {Buffer[]} */
        let cdBatch = [];
        let cdBatchLen = 0;
        const flushCdBatch = async () => {
            if (cdBatchLen === 0) return;
            const buf = cdBatch.length === 1 ? cdBatch[0] : Buffer.concat(cdBatch, cdBatchLen);
            cdBatch = [];
            cdBatchLen = 0;
            await writeAll(buf);
        };

        for (const rec of cdRecords) {
            const needZ64Uncomp = rec.uncompressedSize >= 0xffffffff;
            const needZ64Comp = rec.compressedSize >= 0xffffffff;
            const needZ64Off = rec.localHeaderOffset >= 0xffffffff;
            const needZip64 = needZ64Uncomp || needZ64Comp || needZ64Off;

            let extraBuf = Buffer.alloc(0);
            if (needZip64) {
                const parts = [];
                if (needZ64Uncomp) parts.push(BigInt(rec.uncompressedSize));
                if (needZ64Comp) parts.push(BigInt(rec.compressedSize));
                if (needZ64Off) parts.push(BigInt(rec.localHeaderOffset));
                extraBuf = Buffer.allocUnsafe(4 + parts.length * 8);
                extraBuf.writeUInt16LE(0x0001, 0);
                extraBuf.writeUInt16LE(parts.length * 8, 2);
                for (let k = 0; k < parts.length; k++) {
                    extraBuf.writeBigUInt64LE(parts[k], 4 + k * 8);
                }
            }

            const cdfh = Buffer.allocUnsafe(46 + rec.nameBuf.length + extraBuf.length);
            cdfh.writeUInt32LE(CD_HEADER_SIG, 0);
            cdfh.writeUInt16LE(needZip64 ? 45 : 20, 4); // version made by
            cdfh.writeUInt16LE(needZip64 ? 45 : 20, 6); // version needed
            cdfh.writeUInt16LE(rec.flags, 8);
            cdfh.writeUInt16LE(rec.method, 10);
            cdfh.writeUInt16LE(rec.dosTime, 12);
            cdfh.writeUInt16LE(rec.dosDate, 14);
            cdfh.writeUInt32LE(rec.crc32, 16);
            cdfh.writeUInt32LE(needZ64Comp ? 0xffffffff : rec.compressedSize, 20);
            cdfh.writeUInt32LE(needZ64Uncomp ? 0xffffffff : rec.uncompressedSize, 24);
            cdfh.writeUInt16LE(rec.nameBuf.length, 28);
            cdfh.writeUInt16LE(extraBuf.length, 30);
            cdfh.writeUInt16LE(0, 32); // comment len
            cdfh.writeUInt16LE(0, 34); // disk start
            cdfh.writeUInt16LE(0, 36); // internal attrs
            cdfh.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file POSIX mode
            cdfh.writeUInt32LE(needZ64Off ? 0xffffffff : rec.localHeaderOffset, 42);
            rec.nameBuf.copy(cdfh, 46);
            if (extraBuf.length > 0) extraBuf.copy(cdfh, 46 + rec.nameBuf.length);
            cdBatch.push(cdfh);
            cdBatchLen += cdfh.length;
            if (cdBatchLen >= WRITE_BATCH_BYTES) {
                await flushCdBatch();
            }
        }
        await flushCdBatch();

        const cdSize = offset - cdOffset;
        const needZip64Eocd = cdRecords.length >= 0xffff || cdSize >= 0xffffffff || cdOffset >= 0xffffffff;

        if (needZip64Eocd) {
            const z64EocdOffset = offset;
            const z64Eocd = Buffer.allocUnsafe(56);
            z64Eocd.writeUInt32LE(ZIP64_EOCD_SIG, 0);
            z64Eocd.writeBigUInt64LE(44n, 4);
            z64Eocd.writeUInt16LE(45, 12);
            z64Eocd.writeUInt16LE(45, 14);
            z64Eocd.writeUInt32LE(0, 16);
            z64Eocd.writeUInt32LE(0, 20);
            z64Eocd.writeBigUInt64LE(BigInt(cdRecords.length), 24);
            z64Eocd.writeBigUInt64LE(BigInt(cdRecords.length), 32);
            z64Eocd.writeBigUInt64LE(BigInt(cdSize), 40);
            z64Eocd.writeBigUInt64LE(BigInt(cdOffset), 48);
            await writeAll(z64Eocd);

            const locator = Buffer.allocUnsafe(20);
            locator.writeUInt32LE(ZIP64_EOCD_LOCATOR_SIG, 0);
            locator.writeUInt32LE(0, 4);
            locator.writeBigUInt64LE(BigInt(z64EocdOffset), 8);
            locator.writeUInt32LE(1, 16);
            await writeAll(locator);
        }

        const eocd = Buffer.allocUnsafe(22);
        eocd.writeUInt32LE(EOCD_SIG, 0);
        eocd.writeUInt16LE(0, 4);
        eocd.writeUInt16LE(0, 6);
        eocd.writeUInt16LE(cdRecords.length >= 0xffff ? 0xffff : cdRecords.length, 8);
        eocd.writeUInt16LE(cdRecords.length >= 0xffff ? 0xffff : cdRecords.length, 10);
        eocd.writeUInt32LE(cdSize >= 0xffffffff ? 0xffffffff : cdSize, 12);
        eocd.writeUInt32LE(cdOffset >= 0xffffffff ? 0xffffffff : cdOffset, 16);
        eocd.writeUInt16LE(0, 20);
        await writeAll(eocd);

        await closeAndCleanup(false);
    } catch (err) {
        await closeAndCleanup(true);
        throw err;
    }
}

module.exports = {
    openZip,
    writeZipFromFiles,
    pipeStreams,
    readStreamBuffer
};
