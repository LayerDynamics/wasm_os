//! Byte layout, types, and low-level encoders. See the "Design contract" in
//! docs/plans/2026-06-03-wasmobj-impl.md.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tier {
    B256,
    K1,
    K4,
    K16,
    K64,
}

impl Tier {
    pub const ALL: [Tier; 5] = [Tier::B256, Tier::K1, Tier::K4, Tier::K16, Tier::K64];

    pub fn bytes(self) -> u32 {
        match self {
            Tier::B256 => 256,
            Tier::K1 => 1024,
            Tier::K4 => 4096,
            Tier::K16 => 16384,
            Tier::K64 => 65536,
        }
    }

    /// Smallest tier whose capacity >= n; None if n exceeds the top tier.
    pub fn for_len(n: u32) -> Option<Tier> {
        Tier::ALL.into_iter().find(|t| t.bytes() >= n)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    pub version: u8,
    pub window_offset: u32,
    pub capacity: u32,
    pub content_len: u32,
    pub content_type: u8,
}

impl Header {
    pub const SIZE: usize = 14;

    pub fn encode(&self) -> Vec<u8> {
        let mut b = Vec::with_capacity(Self::SIZE);
        b.push(self.version);
        b.extend_from_slice(&self.window_offset.to_le_bytes());
        b.extend_from_slice(&self.capacity.to_le_bytes());
        b.extend_from_slice(&self.content_len.to_le_bytes());
        b.push(self.content_type);
        b
    }

    pub fn decode(b: &[u8]) -> Result<Header, Error> {
        if b.len() < Self::SIZE {
            return Err(Error::Malformed);
        }
        Ok(Header {
            version: b[0],
            window_offset: u32::from_le_bytes([b[1], b[2], b[3], b[4]]),
            capacity: u32::from_le_bytes([b[5], b[6], b[7], b[8]]),
            content_len: u32::from_le_bytes([b[9], b[10], b[11], b[12]]),
            content_type: b[13],
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    BadVersion,
    OutOfBounds,
    TooLarge,
    Malformed,
}

pub(crate) fn leb_u32(mut v: u32, out: &mut Vec<u8>) {
    loop {
        let mut byte = (v & 0x7f) as u8;
        v >>= 7;
        if v != 0 {
            byte |= 0x80;
        }
        out.push(byte);
        if v == 0 {
            break;
        }
    }
}

/// Decode an unsigned LEB128 u32 at `*pos`, advancing `*pos`. None on overflow/truncation.
pub(crate) fn read_leb_u32(b: &[u8], pos: &mut usize) -> Option<u32> {
    let mut result: u32 = 0;
    let mut shift: u32 = 0;
    loop {
        let byte = *b.get(*pos)?;
        *pos += 1;
        if shift >= 32 {
            return None;
        }
        result |= ((byte & 0x7f) as u32).checked_shl(shift)?;
        if byte & 0x80 == 0 {
            return Some(result);
        }
        shift += 7;
    }
}

pub(crate) fn section(id: u8, payload: &[u8], out: &mut Vec<u8>) {
    out.push(id);
    leb_u32(payload.len() as u32, out);
    out.extend_from_slice(payload);
}

/// Located `wob0` metadata + the file offset of its content_len field.
pub(crate) struct Located {
    pub header: Header,
    /// File offset of the 4-byte content_len field inside the wob0 section data.
    pub wob0_content_len_off: usize,
}

/// Manually scan the module sections for the `wob0` custom section (no wasmparser
/// in the guest hot path). Returns the header + the file offset of its content_len.
pub(crate) fn locate(obj: &[u8]) -> Result<Located, Error> {
    if obj.len() < 8 || &obj[0..4] != b"\0asm" {
        return Err(Error::Malformed);
    }
    let mut pos = 8usize;
    while pos < obj.len() {
        let id = obj[pos];
        pos += 1;
        let len = read_leb_u32(obj, &mut pos).ok_or(Error::Malformed)? as usize;
        let body_start = pos;
        let body_end = body_start.checked_add(len).ok_or(Error::Malformed)?;
        if body_end > obj.len() {
            return Err(Error::Malformed);
        }
        if id == 0 {
            // custom section: name then data
            let mut np = body_start;
            let name_len = read_leb_u32(obj, &mut np).ok_or(Error::Malformed)? as usize;
            let name_end = np.checked_add(name_len).ok_or(Error::Malformed)?;
            if name_end <= body_end && &obj[np..name_end] == b"wob0" {
                let data = &obj[name_end..body_end];
                let header = Header::decode(data)?;
                if header.version != 1 {
                    return Err(Error::BadVersion);
                }
                // content_len is at header offset 9 within the section data.
                let cl_off = name_end + 9;
                // Bounds: window must fit inside the file.
                let wend = (header.window_offset as usize)
                    .checked_add(header.capacity as usize)
                    .ok_or(Error::Malformed)?;
                if wend > obj.len() || header.capacity < 4 {
                    return Err(Error::OutOfBounds);
                }
                if header.content_len + 4 > header.capacity {
                    return Err(Error::OutOfBounds);
                }
                return Ok(Located {
                    header,
                    wob0_content_len_off: cl_off,
                });
            }
        }
        pos = body_end;
    }
    Err(Error::Malformed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leb_roundtrips() {
        for v in [0u32, 1, 127, 128, 256, 16384, 65536, u32::MAX] {
            let mut buf = Vec::new();
            leb_u32(v, &mut buf);
            let mut pos = 0;
            assert_eq!(read_leb_u32(&buf, &mut pos), Some(v));
            assert_eq!(pos, buf.len());
        }
    }

    #[test]
    fn tier_for_len_picks_smallest() {
        assert_eq!(Tier::for_len(0), Some(Tier::B256));
        assert_eq!(Tier::for_len(256), Some(Tier::B256));
        assert_eq!(Tier::for_len(257), Some(Tier::K1));
        assert_eq!(Tier::for_len(65536), Some(Tier::K64));
        assert_eq!(Tier::for_len(65537), None);
    }

    #[test]
    fn header_encodes_to_14_le_bytes() {
        let h = Header {
            version: 1,
            window_offset: 0x1122_3344,
            capacity: 4096,
            content_len: 7,
            content_type: 0,
        };
        let b = h.encode();
        assert_eq!(b.len(), 14);
        assert_eq!(&b[1..5], &0x1122_3344u32.to_le_bytes());
        assert_eq!(Header::decode(&b).unwrap(), h);
    }
}
