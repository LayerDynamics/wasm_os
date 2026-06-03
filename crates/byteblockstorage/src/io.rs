//! The operations over object bytes: read, verify, write-in-place, repack, save.

use crate::format::{locate, Error, Header};

/// Validate the bbs0 header + window bounds; returns the parsed header.
pub fn verify(obj: &[u8]) -> Result<Header, Error> {
    Ok(locate(obj)?.header)
}

/// Read exactly content_len content bytes (excludes the in-band length prefix + padding).
pub fn read(obj: &[u8]) -> Result<Vec<u8>, Error> {
    let loc = locate(obj)?;
    let h = loc.header;
    let start = h.window_offset as usize + 4;
    let end = start + h.content_len as usize;
    obj.get(start..end).map(|s| s.to_vec()).ok_or(Error::OutOfBounds)
}

/// Alias of `read`, named for the FR-7b plain-export intent.
pub fn extract(obj: &[u8]) -> Result<Vec<u8>, Error> {
    read(obj)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{mint, Tier};

    #[test]
    fn read_blank_is_empty() {
        let obj = mint(Tier::K4, 0);
        assert_eq!(read(&obj).unwrap(), Vec::<u8>::new());
        assert!(verify(&obj).is_ok());
    }

    #[test]
    fn malformed_never_panics() {
        assert!(verify(b"not wasm").is_err());
        assert!(read(&[0u8; 4]).is_err());
        let mut obj = mint(Tier::B256, 0);
        obj.truncate(10);
        assert!(verify(&obj).is_err());
    }
}
