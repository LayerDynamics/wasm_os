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

/// Overwrite the window in place: content + 0x20 padding, update both content_len
/// copies (in-band prefix + bbs0). No module re-encode. Errors if content exceeds
/// capacity-4.
pub fn write_in_place(obj: &mut [u8], content: &[u8]) -> Result<(), Error> {
    let loc = locate(obj)?;
    let h = loc.header;
    let cap = h.capacity as usize;
    let content_capacity = cap - 4;
    if content.len() > content_capacity {
        return Err(Error::TooLarge);
    }
    let w = h.window_offset as usize;
    let len = content.len() as u32;
    // in-band length prefix
    obj[w..w + 4].copy_from_slice(&len.to_le_bytes());
    // content
    obj[w + 4..w + 4 + content.len()].copy_from_slice(content);
    // padding
    for b in &mut obj[w + 4 + content.len()..w + cap] {
        *b = 0x20;
    }
    // mirror into bbs0
    let cl = loc.bbs0_content_len_off;
    obj[cl..cl + 4].copy_from_slice(&len.to_le_bytes());
    Ok(())
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

    // test helper: file offset of bbs0 content_len in a freshly minted/clean object
    fn locate_cl(obj: &[u8]) -> usize {
        crate::format::locate(obj).unwrap().bbs0_content_len_off
    }

    #[test]
    fn write_in_place_roundtrips_and_preserves_non_window_bytes() {
        let mut obj = mint(Tier::K4, 0);
        let before = obj.clone();
        let h = verify(&obj).unwrap();
        let w = h.window_offset as usize;
        let cap = h.capacity as usize;

        let content = b"hello byteblockstorage".to_vec();
        write_in_place(&mut obj, &content).unwrap();

        assert_eq!(read(&obj).unwrap(), content);
        // in-band len + bbs0 content_len both updated
        assert_eq!(verify(&obj).unwrap().content_len as usize, content.len());
        assert_eq!(&obj[w..w + 4], &(content.len() as u32).to_le_bytes());
        // padding after content is 0x20
        assert!(obj[w + 4 + content.len()..w + cap].iter().all(|&b| b == 0x20));
        // EVERYTHING outside the window AND outside the bbs0 content_len field is unchanged
        assert_eq!(obj.len(), before.len());
        let cl = locate_cl(&before);
        for i in 0..obj.len() {
            let in_window = i >= w && i < w + cap;
            let in_cl = (cl..cl + 4).contains(&i);
            if !in_window && !in_cl {
                assert_eq!(obj[i], before[i], "byte {i} changed unexpectedly");
            }
        }
    }

    #[test]
    fn write_too_large_errors() {
        let mut obj = mint(Tier::B256, 0);
        let too_big = vec![b'x'; 256]; // > capacity-4
        assert!(matches!(write_in_place(&mut obj, &too_big), Err(crate::Error::TooLarge)));
    }
}
