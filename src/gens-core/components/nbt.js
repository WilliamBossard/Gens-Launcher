const zlib = require('zlib');

const TAG_END = 0;
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

const typeNames = {
    1: 'byte', 2: 'short', 3: 'int', 4: 'long', 5: 'float', 6: 'double',
    7: 'byteArray', 8: 'string', 9: 'list', 10: 'compound', 11: 'intArray', 12: 'longArray'
};

const typeIds = Object.fromEntries(Object.entries(typeNames).map(([k, v]) => [v, parseInt(k)]));

class NBTReader {
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
        const v = this.buffer.toString('utf8', this.offset, this.offset + len);
        this.offset += len;
        return v;
    }

    readTag(type) {
        switch (type) {
            case TAG_BYTE: return this.readByte();
            case TAG_SHORT: return this.readShort();
            case TAG_INT: return this.readInt();
            case TAG_LONG: return this.readLong();
            case TAG_FLOAT: return this.readFloat();
            case TAG_DOUBLE: return this.readDouble();
            case TAG_BYTE_ARRAY: {
                const len = this.readInt();
                const v = this.buffer.slice(this.offset, this.offset + len);
                this.offset += len;
                return Array.from(v); // prismarine compat
            }
            case TAG_STRING: return this.readString();
            case TAG_LIST: {
                const listType = this.readByte();
                const len = this.readInt();
                const val = [];
                for (let i = 0; i < len; i++) {
                    val.push(this.readTag(listType));
                }
                return { type: typeNames[listType] || 'end', value: val };
            }
            case TAG_COMPOUND: {
                const val = {};
                while (true) {
                    const nextType = this.readByte();
                    if (nextType === TAG_END) break;
                    const name = this.readString();
                    val[name] = { type: typeNames[nextType], value: this.readTag(nextType) };
                }
                return val;
            }
            case TAG_INT_ARRAY: {
                const len = this.readInt();
                const val = [];
                for (let i = 0; i < len; i++) val.push(this.readInt());
                return val;
            }
            case TAG_LONG_ARRAY: {
                const len = this.readInt();
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

    ensureCapacity(size) {
        if (this.offset + size > this.buffer.length) {
            const newBuf = Buffer.alloc(this.buffer.length * 2 + size);
            this.buffer.copy(newBuf);
            this.buffer = newBuf;
        }
    }

    writeByte(v) { this.ensureCapacity(1); this.buffer.writeInt8(v, this.offset); this.offset += 1; }
    writeShort(v) { this.ensureCapacity(2); this.buffer.writeInt16BE(v, this.offset); this.offset += 2; }
    writeInt(v) { this.ensureCapacity(4); this.buffer.writeInt32BE(v, this.offset); this.offset += 4; }
    writeLong(v) { 
        this.ensureCapacity(8);
        if (Array.isArray(v)) {
            this.buffer.writeInt32BE(v[0], this.offset);
            this.buffer.writeInt32BE(v[1], this.offset + 4);
        } else {
            this.buffer.writeInt32BE(0, this.offset);
            this.buffer.writeInt32BE(v, this.offset + 4);
        }
        this.offset += 8; 
    }
    writeFloat(v) { this.ensureCapacity(4); this.buffer.writeFloatBE(v, this.offset); this.offset += 4; }
    writeDouble(v) { this.ensureCapacity(8); this.buffer.writeDoubleBE(v, this.offset); this.offset += 8; }
    
    writeString(v) {
        const len = Buffer.byteLength(v, 'utf8');
        this.ensureCapacity(2 + len);
        this.buffer.writeUInt16BE(len, this.offset);
        this.offset += 2;
        this.buffer.write(v, this.offset, len, 'utf8');
        this.offset += len;
    }

    writeTag(type, value) {
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
                for (let i = 0; i < value.length; i++) this.buffer.writeUInt8(value[i], this.offset++);
                break;
            }
            case TAG_STRING: this.writeString(value); break;
            case TAG_LIST: {
                const listType = value.type === 'end' ? 0 : typeIds[value.type];
                this.writeByte(listType);
                this.writeInt(value.value.length);
                for (const item of value.value) {
                    this.writeTag(listType, item);
                }
                break;
            }
            case TAG_COMPOUND: {
                for (const [name, tag] of Object.entries(value)) {
                    const t = typeIds[tag.type];
                    this.writeByte(t);
                    this.writeString(name);
                    this.writeTag(t, tag.value);
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
        }
    }

    writeRoot(root) {
        const type = typeIds[root.type];
        this.writeByte(type);
        this.writeString(root.name || '');
        this.writeTag(type, root.value);
        return this.buffer.slice(0, this.offset);
    }
}

async function parse(buffer) {
    let buf = buffer;
    try { 
        const util = require('util');
        const gunzip = util.promisify(zlib.gunzip);
        buf = await gunzip(buffer); 
    } catch (err) { }
    const reader = new NBTReader(buf);
    return { parsed: reader.readRoot() };
}

function writeUncompressed(data) {
    const writer = new NBTWriter();
    return writer.writeRoot(data);
}

module.exports = {
    parse,
    writeUncompressed
};
