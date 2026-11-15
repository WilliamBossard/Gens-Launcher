// @ts-check
const zlib = require('zlib');

const TAG_END = 0;
const MAX_NBT_DEPTH = 512;
const TAG_BYTE = 1;
const TAG_SHORT = 2;
const TAG_INT = 3;
const TAG_LONG = 4;
const TAG_FLOAT = 5;
const TAG_DOUBLE = 6;
const TAG_BYTE_ARRAY = 7;
const TAG_STRING = 8;
const TAG_LIST = 9;
const TAG_COMPOUND = 10;
const TAG_INT_ARRAY = 11;
const TAG_LONG_ARRAY = 12;

/** @type {Record<number, string>} */
const typeNames = {
    1: 'byte', 2: 'short', 3: 'int', 4: 'long', 5: 'float', 6: 'double',
    7: 'byteArray', 8: 'string', 9: 'list', 10: 'compound', 11: 'intArray', 12: 'longArray'
};

/** @type {Record<string, number>} */
const typeIds = Object.fromEntries(Object.entries(typeNames).map(([k, v]) => [v, parseInt(k)]));

class NBTReader {
    /**
     * @param {Buffer} buffer
     */
    constructor(buffer) {
        this.buffer = buffer;
        this.offset = 0;
    }

    readByte() { const v = this.buffer.readInt8(this.offset); this.offset += 1; return v; }
    readShort() { const v = this.buffer.readInt16BE(this.offset); this.offset += 2; return v; }
    readInt() { const v = this.buffer.readInt32BE(this.offset); this.offset += 4; return v; }
    readLong() { 
        const hi = this.buffer.readInt32BE(this.offset);
        const lo = this.buffer.readInt32BE(this.offset + 4);
        this.offset += 8;
        return [hi, lo]; // prismarine-nbt compat
    }
    readFloat() { const v = this.buffer.readFloatBE(this.offset); this.offset += 4; return v; }
    readDouble() { const v = this.buffer.readDoubleBE(this.offset); this.offset += 8; return v; }
    
    readString() {
        const len = this.buffer.readUInt16BE(this.offset);
        this.offset += 2;
        if (this.offset + len > this.buffer.length) {
            throw new Error(`NBT string truncated (len=${len})`);
        }
        const v = this.buffer.toString('utf8', this.offset, this.offset + len);
        this.offset += len;
        return v;
    }

    /**
     * @param {number} len
     * @param {number} itemMinBytes
     * @param {string} label
     */
    _assertArrayCount(len, itemMinBytes, label) {
        if (len < 0) throw new Error(`Invalid negative length for ${label}: ${len}`);
        const remaining = this.buffer.length - this.offset;
        if (len * itemMinBytes > remaining) {
            throw new Error(`NBT ${label} length (${len}) exceeds remaining buffer (${remaining})`);
        }
    }

    /**
     * @param {number} type
     * @param {number} [depth=0]
     * @returns {any}
     */
    readTag(type, depth = 0) {
        if (depth > 64) {
            throw new Error('NBT maximum nesting depth exceeded');
        }
        switch (type) {
            case TAG_BYTE: return this.readByte();
            case TAG_SHORT: return this.readShort();
            case TAG_INT: return this.readInt();
            case TAG_LONG: return this.readLong();
            case TAG_FLOAT: return this.readFloat();
            case TAG_DOUBLE: return this.readDouble();
            case TAG_BYTE_ARRAY: {
                const len = this.readInt();
                this._assertArrayCount(len, 1, 'byteArray');
                const v = this.buffer.slice(this.offset, this.offset + len);
                this.offset += len;
                return Array.from(v); // prismarine compat
            }
            case TAG_STRING: return this.readString();
            case TAG_LIST: {
                const listType = this.readByte();
                const len = this.readInt();
                const minBytes = listType === TAG_END ? 0 : (listType === TAG_BYTE ? 1 : (listType === TAG_SHORT ? 2 : 1));
                this._assertArrayCount(len, minBytes, 'list');
                const val = [];
                for (let i = 0; i < len; i++) {
                    val.push(this.readTag(listType, depth + 1));
                }
                return { type: typeNames[listType] || 'end', value: val };
            }
            case TAG_COMPOUND: {
                /** @type {Record<string, { type: string, value: any }>} */
                const val = Object.create(null);
                while (true) {
                    const nextType = this.readByte();
                    if (nextType === TAG_END) break;
                    if (!typeNames[nextType]) {
                        throw new Error(`Unknown tag type: ${nextType}`);
                    }
                    const name = this.readString();
                    val[name] = { type: typeNames[nextType], value: this.readTag(nextType, depth + 1) };
                }
                return val;
            }
            case TAG_INT_ARRAY: {
                const len = this.readInt();
                this._assertArrayCount(len, 4, 'intArray');
                const val = [];
                for (let i = 0; i < len; i++) val.push(this.readInt());
                return val;
            }
            case TAG_LONG_ARRAY: {
                const len = this.readInt();
                this._assertArrayCount(len, 8, 'longArray');
                const val = [];
                for (let i = 0; i < len; i++) val.push(this.readLong());
                return val;
            }
            default:
                throw new Error(`Unknown tag type: ${type}`);
        }
    }

    readRoot() {
        const type = this.readByte();
        if (type === TAG_END) return { type: 'end', name: '', value: null };
        const name = this.readString();
        const value = this.readTag(type);
        return { type: typeNames[type], name, value };
    }
}

class NBTWriter {
    constructor() {
        this.buffer = Buffer.alloc(1024 * 64);
        this.offset = 0;
    }

    /**
     * @param {number} size
     */
    ensureCapacity(size) {
        if (this.offset + size > this.buffer.length) {
            const newBuf = Buffer.alloc(this.buffer.length * 2 + size);
            this.buffer.copy(newBuf);
            this.buffer = newBuf;
        }
    }

    /** @param {number} v */
    writeByte(v) { this.ensureCapacity(1); this.buffer.writeInt8(v, this.offset); this.offset += 1; }
    /** @param {number} v */
    writeShort(v) { this.ensureCapacity(2); this.buffer.writeInt16BE(v, this.offset); this.offset += 2; }
    /** @param {number} v */
    writeInt(v) { this.ensureCapacity(4); this.buffer.writeInt32BE(v, this.offset); this.offset += 4; }
    /** @param {number | bigint | number[]} v */
    writeLong(v) { 
        this.ensureCapacity(8);
        if (Array.isArray(v)) {
            this.buffer.writeInt32BE(v[0], this.offset);
            this.buffer.writeInt32BE(v[1], this.offset + 4);
        } else if (typeof v === 'bigint') {
            this.buffer.writeBigInt64BE(v, this.offset);
        } else {
            this.buffer.writeBigInt64BE(BigInt(Math.trunc(Number(v) || 0)), this.offset);
        }
        this.offset += 8; 
    }
    /** @param {number} v */
    writeFloat(v) { this.ensureCapacity(4); this.buffer.writeFloatBE(v, this.offset); this.offset += 4; }
    /** @param {number} v */
    writeDouble(v) { this.ensureCapacity(8); this.buffer.writeDoubleBE(v, this.offset); this.offset += 8; }
    
    /** @param {string} v */
    writeString(v) {
        const str = v || '';
        const len = Buffer.byteLength(str, 'utf8');
        if (len > 65535) {
            throw new RangeError(`Chaîne NBT trop longue (${len} > 65535 octets).`);
        }
        this.ensureCapacity(2 + len);
        this.buffer.writeUInt16BE(len, this.offset);
        this.offset += 2;
        this.buffer.write(str, this.offset, len, 'utf8');
        this.offset += len;
    }

    /**
     * @param {number} type
     * @param {any} value
     * @param {number} [depth=0]
     */
    writeTag(type, value, depth = 0) {
        if (depth > MAX_NBT_DEPTH) {
            throw new RangeError(`Profondeur NBT maximale dépassée lors de l'écriture (>${MAX_NBT_DEPTH}).`);
        }
        switch (type) {
            case TAG_BYTE: this.writeByte(value); break;
            case TAG_SHORT: this.writeShort(value); break;
            case TAG_INT: this.writeInt(value); break;
            case TAG_LONG: this.writeLong(value); break;
            case TAG_FLOAT: this.writeFloat(value); break;
            case TAG_DOUBLE: this.writeDouble(value); break;
            case TAG_BYTE_ARRAY: {
                this.writeInt(value.length);
                this.ensureCapacity(value.length);
                const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
                bytes.copy(this.buffer, this.offset);
                this.offset += bytes.length;
                break;
            }
            case TAG_STRING: this.writeString(value); break;
            case TAG_LIST: {
                const listType = value.type === 'end' ? 0 : typeIds[value.type];
                if (listType === undefined) {
                    throw new Error(`Unknown NBT list element type: ${value.type}`);
                }
                this.writeByte(listType);
                this.writeInt(value.value.length);
                for (const item of value.value) {
                    this.writeTag(listType, item, depth + 1);
                }
                break;
            }
            case TAG_COMPOUND: {
                for (const [name, tag] of Object.entries(value)) {
                    const t = typeIds[tag.type];
                    if (t === undefined) {
                        throw new Error(`Unknown NBT tag type for "${name}": ${tag.type}`);
                    }
                    this.writeByte(t);
                    this.writeString(name);
                    this.writeTag(t, tag.value, depth + 1);
                }
                this.writeByte(TAG_END);
                break;
            }
            case TAG_INT_ARRAY: {
                this.writeInt(value.length);
                for (const item of value) this.writeInt(item);
                break;
            }
            case TAG_LONG_ARRAY: {
                this.writeInt(value.length);
                for (const item of value) this.writeLong(item);
                break;
            }
            default:
                throw new Error(`Unknown NBT tag type ID: ${type}`);
        }
    }

    /**
     * @param {any} root
     * @returns {Buffer}
     */
    writeRoot(root) {
        const type = typeIds[root.type];
        if (type === undefined) {
            throw new Error(`Unknown NBT root tag type: ${root?.type}`);
        }
        this.writeByte(type);
        this.writeString(root.name || '');
        this.writeTag(type, root.value, 0);
        return this.buffer.slice(0, this.offset);
    }
}

/**
 * Parses NBT data from a Buffer (handles gzip compressed or uncompressed).
 * @param {Buffer} buffer
 * @returns {Promise<{ parsed: any }>}
 */
const MAX_NBT_UNCOMPRESSED_BYTES = 20 * 1024 * 1024;

/**
 * Parses NBT data from a Buffer (handles gzip compressed or uncompressed).
 * @param {Buffer} buffer
 * @returns {Promise<{ parsed: any }>}
 */
async function parse(buffer) {
    let buf = buffer;
    const isGzip = Buffer.isBuffer(buffer) && buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
    if (isGzip) {
        const util = require('util');
        const gunzip = util.promisify(zlib.gunzip);
        buf = await gunzip(buffer, { maxOutputLength: MAX_NBT_UNCOMPRESSED_BYTES });
    } else if (Buffer.isBuffer(buffer) && buffer.length > MAX_NBT_UNCOMPRESSED_BYTES) {
        throw new Error('NBT buffer exceeds maximum allowed size');
    }
    const reader = new NBTReader(buf);
    return { parsed: reader.readRoot() };
}

/**
 * Serializes NBT data structure to an uncompressed Buffer.
 * @param {any} data
 * @returns {Buffer}
 */
function writeUncompressed(data) {
    const writer = new NBTWriter();
    return writer.writeRoot(data);
}

module.exports = {
    parse,
    writeUncompressed
};
