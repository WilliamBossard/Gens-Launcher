//! Pure-Rust binary NBT parser (uncompressed & gzipped, anti-Gzip-bomb & bounds-checked,
//! compatible with prismarine-nbt JSON format).

use flate2::read::GzDecoder;
use serde_json::{json, Map, Value};
use std::io::Read;

const MAX_NBT_DECOMPRESSED_BYTES: u64 = 16 * 1024 * 1024; // 16 MiB
const MAX_NBT_ARRAY_LEN: usize = 1_000_000;
const MAX_NBT_DEPTH: usize = 64;

pub fn parse_nbt(raw: &[u8]) -> Result<Value, String> {
    let data: Vec<u8> = if raw.len() >= 2 && raw[0] == 0x1f && raw[1] == 0x8b {
        let dec = GzDecoder::new(raw);
        let mut limited = dec.take(MAX_NBT_DECOMPRESSED_BYTES + 1);
        let mut buf = Vec::new();
        limited.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        if (buf.len() as u64) > MAX_NBT_DECOMPRESSED_BYTES {
            return Err("Archive NBT Gzip trop volumineuse (> 16 Mio).".into());
        }
        buf
    } else {
        if (raw.len() as u64) > MAX_NBT_DECOMPRESSED_BYTES {
            return Err("Flux NBT trop volumineux (> 16 Mio).".into());
        }
        raw.to_vec()
    };

    let mut cur = Cursor {
        data: &data,
        pos: 0,
    };
    let root_type = cur.read_u8()?;
    if root_type != 10 {
        return Err(format!("Tag racine NBT invalide: {}", root_type));
    }
    let name = cur.read_string()?;
    let val = cur.read_payload(10, 0)?;
    Ok(json!({
        "name": name,
        "type": "compound",
        "value": val
    }))
}

struct Cursor<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn read_bytes(&mut self, n: usize) -> Result<&'a [u8], String> {
        let end = self
            .pos
            .checked_add(n)
            .ok_or_else(|| "Débordement de taille NBT".to_string())?;
        if end > self.data.len() {
            return Err("Fin de flux NBT inattendue".into());
        }
        let s = &self.data[self.pos..end];
        self.pos = end;
        Ok(s)
    }
    fn read_u8(&mut self) -> Result<u8, String> {
        Ok(self.read_bytes(1)?[0])
    }
    fn read_i8(&mut self) -> Result<i8, String> {
        Ok(self.read_u8()? as i8)
    }
    fn read_i16(&mut self) -> Result<i16, String> {
        let b = self.read_bytes(2)?;
        Ok(i16::from_be_bytes([b[0], b[1]]))
    }
    fn read_u16(&mut self) -> Result<u16, String> {
        let b = self.read_bytes(2)?;
        Ok(u16::from_be_bytes([b[0], b[1]]))
    }
    fn read_i32(&mut self) -> Result<i32, String> {
        let b = self.read_bytes(4)?;
        Ok(i32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn read_i64(&mut self) -> Result<i64, String> {
        let b = self.read_bytes(8)?;
        Ok(i64::from_be_bytes([
            b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
        ]))
    }
    fn read_f32(&mut self) -> Result<f32, String> {
        let b = self.read_bytes(4)?;
        Ok(f32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn read_f64(&mut self) -> Result<f64, String> {
        let b = self.read_bytes(8)?;
        Ok(f64::from_be_bytes([
            b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
        ]))
    }
    fn read_string(&mut self) -> Result<String, String> {
        let len = self.read_u16()? as usize;
        let b = self.read_bytes(len)?;
        Ok(String::from_utf8_lossy(b).into_owned())
    }
    fn read_checked_len(&mut self, item_min_bytes: usize) -> Result<usize, String> {
        let raw = self.read_i32()?;
        if raw < 0 {
            return Err("Longueur de tableau NBT négative".into());
        }
        let len = raw as usize;
        if len > MAX_NBT_ARRAY_LEN {
            return Err(format!("Longueur de tableau NBT excessive ({})", len));
        }
        let remaining = self.data.len().saturating_sub(self.pos);
        if item_min_bytes > 0 && len.saturating_mul(item_min_bytes) > remaining {
            return Err("Tableau NBT tronqué".into());
        }
        Ok(len)
    }

    fn type_name(t: u8) -> &'static str {
        match t {
            1 => "byte",
            2 => "short",
            3 => "int",
            4 => "long",
            5 => "float",
            6 => "double",
            7 => "byteArray",
            8 => "string",
            9 => "list",
            10 => "compound",
            11 => "intArray",
            12 => "longArray",
            _ => "end",
        }
    }

    fn read_payload(&mut self, tag: u8, depth: usize) -> Result<Value, String> {
        if depth > MAX_NBT_DEPTH {
            return Err("Profondeur NBT dépassée".into());
        }
        match tag {
            1 => Ok(json!(self.read_i8()?)),
            2 => Ok(json!(self.read_i16()?)),
            3 => Ok(json!(self.read_i32()?)),
            4 => {
                let v = self.read_i64()?;
                Ok(json!([(v >> 32) as i32, (v & 0xffffffff) as i32]))
            }
            5 => Ok(json!(self.read_f32()?)),
            6 => Ok(json!(self.read_f64()?)),
            7 => {
                let len = self.read_checked_len(1)?;
                let b = self.read_bytes(len)?;
                Ok(json!(b.iter().map(|&x| x as i8).collect::<Vec<_>>()))
            }
            8 => Ok(json!(self.read_string()?)),
            9 => {
                let item_tag = self.read_u8()?;
                let len = self.read_checked_len(if item_tag == 0 { 0 } else { 1 })?;
                let mut arr = Vec::with_capacity(len.min(1024));
                for _ in 0..len {
                    arr.push(self.read_payload(item_tag, depth + 1)?);
                }
                Ok(json!({ "type": Self::type_name(item_tag), "value": arr }))
            }
            10 => {
                let mut map = Map::new();
                loop {
                    let child_tag = self.read_u8()?;
                    if child_tag == 0 {
                        break;
                    }
                    let name = self.read_string()?;
                    let v = self.read_payload(child_tag, depth + 1)?;
                    map.insert(name, json!({ "type": Self::type_name(child_tag), "value": v }));
                }
                Ok(Value::Object(map))
            }
            11 => {
                let len = self.read_checked_len(4)?;
                let mut arr = Vec::with_capacity(len.min(1024));
                for _ in 0..len {
                    arr.push(self.read_i32()?);
                }
                Ok(json!(arr))
            }
            12 => {
                let len = self.read_checked_len(8)?;
                let mut arr = Vec::with_capacity(len.min(1024));
                for _ in 0..len {
                    let v = self.read_i64()?;
                    arr.push(json!([(v >> 32) as i32, (v & 0xffffffff) as i32]));
                }
                Ok(json!(arr))
            }
            _ => Err(format!("Tag NBT inconnu: {}", tag)),
        }
    }
}
